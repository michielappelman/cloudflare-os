// The Cloudflare API binding end to end, through the real Durable Object and a fake Cloudflare API:
// reads are observed, changes are only sent once approved, a change to a resource that moved since
// it was requested is refused, and nothing outside the bound account is reachable.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareApiGatekeeperProps } from "../../src/api-gatekeeper.js";
import type { CloudflareApiRequest } from "../../src/api-types.js";
import type { ApiCallOutcome, TestObserver } from "../worker.js";
import { SUPER_ADMINISTRATOR_GROUP_ID } from "../../src/membership.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const FOREIGN_ZONE = "99999999999999999999999999999999";
const RECORD = "372e67954025e0ba6aaa6d586b9e0b59";
const API = "https://api.cloudflare.com/client/v4";
const USER = "7c5dae5552338874e5053f2534d2767a";
const OTHER_USER = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
/** What every read through a binding of ACCOUNT made by USER reports. */
const SUBRESOURCE = `api/account/${ACCOUNT}/user/${USER}`;

const ADMIN_GROUP = "201e1f6a044241d9b27fe344e1baee06";
const DNS_GROUP = "4755a26eedb94da69e1066d98aa820be";

/** One `GET /memberships` entry: `groups` held over all of `account`, or over one zone of it. */
function membership(account: string, groups: string[], zoneOnly = false) {
  const key = `com.cloudflare.api.account.${account}`;
  return {
    status: "accepted", account: { id: account },
    policies: [{
      access: "allow",
      permission_groups: groups.map(id => ({ id })),
      resource_groups: [{ scope: zoneOnly
        ? { key, objects: [{ key: `com.cloudflare.api.account.zone.${ZONE}` }] }
        : { key, objects: [{ key: "*" }] } }],
    }],
  };
}

/** What the fake `/memberships` answers, by access token. */
let memberships: Record<string, unknown[] | null>;

let userObjectId: string;
let facets = 0;
let record: Record<string, unknown>;
let sent: Array<{ method: string; url: string; body?: string }>;
/** The zone tag the fake GraphQL endpoint puts on every row it returns. */
let graphqlRowTag: string;

function ok(result: unknown, resultInfo?: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result, result_info: resultInfo });
}

function fakeCloudflare() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ method, url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    const path = url.slice(API.length).split("?")[0];
    if (method === "GET" && path === "/user") return ok({ id: USER.toUpperCase(), email: "ann@example.com" });
    if (method === "GET" && path === "/memberships") {
      const token = String(new Headers(init.headers).get("Authorization")).slice("Bearer ".length);
      const list = memberships[token];
      return list ? ok(list, { per_page: 50 }) : new Response("down", { status: 503 });
    }
    if (method === "GET" && path === `/zones/${ZONE}`) {
      return ok({ id: ZONE, name: "example.com", status: "active", account: { id: ACCOUNT } });
    }
    if (method === "GET" && path === `/zones/${FOREIGN_ZONE}`) {
      return ok({ id: FOREIGN_ZONE, name: "other.com", status: "active", account: { id: OTHER_ACCOUNT } });
    }
    if (method === "GET" && path === "/zones") {
      return ok([
        { id: ZONE, name: "example.com", account: { id: ACCOUNT } },
        { id: FOREIGN_ZONE, name: "other.com", account: { id: OTHER_ACCOUNT } },
      ]);
    }
    if (method === "GET" && path === `/zones/${ZONE}/dns_records`) return ok([record], { page: 1 });
    if (method === "POST" && path === "/graphql") {
      return Response.json({ data: { viewer: { zones: [
        { httpRequests1dGroups: [{ sum: { requests: 42 } }], _cfosScopeTag: graphqlRowTag },
      ] } } });
    }
    if (method === "POST" && path === `/zones/${ZONE}/dns_records`) {
      return ok({ id: "new", ...JSON.parse(init.body as string) });
    }
    if (path === `/zones/${ZONE}/dns_records/${RECORD}`) {
      if (method === "GET") return ok(record);
      if (method === "PATCH") {
        record = { ...record, ...JSON.parse(init.body as string) };
        return ok(record);
      }
    }
    return Response.json({ success: false, errors: [{ code: 7003, message: "No route" }] }, { status: 404 });
  }));
}

function props(extra: Partial<CloudflareApiGatekeeperProps> = {}): CloudflareApiGatekeeperProps {
  return { userObjectId, accountId: ACCOUNT, readOnly: false, ...extra };
}

const hooks = () => env.TEST_HOOKS.getByName("api-hooks");

// The namespace's RPC typing cannot express ActionDescription's field union, so the outcome is
// typed here.
function call(facet: string, binding: CloudflareApiGatekeeperProps, target: string,
  request?: CloudflareApiRequest): Promise<ApiCallOutcome> {
  return hooks().apiCall(facet, binding, "call", target, request) as unknown as Promise<ApiCallOutcome>;
}

function graphql(facet: string, binding: CloudflareApiGatekeeperProps, query: string,
  variables?: Record<string, unknown>): Promise<ApiCallOutcome> {
  return hooks().apiCall(facet, binding, "graphql", query, variables) as unknown as Promise<ApiCallOutcome>;
}

function actionResult(facet: string, binding: CloudflareApiGatekeeperProps, actionId: number):
    Promise<ApiCallOutcome> {
  return hooks().apiCall(facet, binding, "getActionResult", actionId) as unknown as Promise<ApiCallOutcome>;
}

beforeAll(async () => {
  const id = env.USER_ACCOUNT.idFromName("api-account");
  userObjectId = id.toString();
  await runInDurableObject(env.USER_ACCOUNT.get(id), (_account, state) => {
    state.storage.kv.put("refreshToken", "refresh-1");
    state.storage.kv.put("accessToken", { token: "access-1", expires: Date.now() + 3_600_000 });
    // As learned when the credentials were installed; "who this connection is" tests the lookup.
    state.storage.kv.put("cloudflareUserId", USER);
    state.storage.kv.put("grantedScopes", ["memberships.read"]);
  });
});

beforeEach(() => {
  record = { id: RECORD, type: "A", name: "www.example.com", content: "192.0.2.1" };
  graphqlRowTag = ZONE;
  memberships = { "access-1": [membership(OTHER_ACCOUNT, [DNS_GROUP]), membership(ACCOUNT, [ADMIN_GROUP])] };
  sent = [];
  fakeCloudflare();
});

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare API binding", () => {
  it("returns reads and records them as observations", async () => {
    const outcome = await call(`api-${facets++}`, props(), "dns.records.list", {
      path: { zone_id: ZONE }, query: { type: "A" },
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toMatchObject({ status: "ok", result: [record] });
    expect(outcome.observations).toHaveLength(1);
    // Every read names the account as the connection's own Cloudflare user sees it.
    expect(outcome.observations[0]!.subresources).toEqual([SUBRESOURCE]);
    expect(outcome.submissions).toHaveLength(0);
    expect(sent.map(r => r.method)).toEqual(["GET", "GET"]);
  });

  it("refuses a zone that belongs to another account", async () => {
    const outcome = await call(`api-${facets++}`, props(), "dns.records.list", {
      path: { zone_id: FOREIGN_ZONE },
    });

    expect(outcome.error).toMatch(/not in account/);
    expect(outcome.observations).toHaveLength(0);
    expect(sent.some(r => r.url.includes(`${FOREIGN_ZONE}/dns_records`))).toBe(false);
  });

  it("pins the zone list to the bound account and drops anything else", async () => {
    const outcome = await call(`api-${facets++}`, props(), "zones.list");

    expect(outcome.result).toMatchObject({ status: "ok", result: [{ id: ZONE }] });
    expect(sent[0]!.url).toContain(`account.id=${ACCOUNT}`);
  });

  it("sends a change only once it is approved, exactly as approved", async () => {
    const facet = `api-${facets++}`;
    const body = { type: "A", name: "api.example.com", content: "192.0.2.10", proxied: true, ttl: 1 };
    const staged = await call(facet, props(), "dns.records.create", {
      path: { zone_id: ZONE }, body,
    });

    expect(staged.error).toBeUndefined();
    expect(staged.result).toMatchObject({ status: "pending" });
    expect(staged.submissions[0]!.description).toMatchObject({
      autoApprovable: true, actionKind: { tag: "cloudflare.api.dns" },
    });
    expect(sent.some(r => r.method === "POST")).toBe(false);

    const actionId = (staged.result as { actionId: number }).actionId;
    expect(await hooks().apiApply(facet, props(), actionId)).toBeNull();
    const post = sent.find(r => r.method === "POST")!;
    expect(post.body).toBe(JSON.stringify(body));

    const collected = await actionResult(facet, props(), actionId);
    expect(collected.result).toMatchObject({ status: "ok", result: { id: "new", name: "api.example.com" } });
    expect(collected.observations).toHaveLength(1);

    // A second approval of the same action is a no-op.
    expect(await hooks().apiApply(facet, props(), actionId)).toBeNull();
    expect(sent.filter(r => r.method === "POST")).toHaveLength(1);
  });

  it("refuses a change to a resource that changed after it was requested", async () => {
    const facet = `api-${facets++}`;
    const staged = await call(facet, props(), "dns.records.edit", {
      path: { zone_id: ZONE, dns_record_id: RECORD }, body: { content: "192.0.2.99" },
    });
    expect(staged.submissions[0]!.description.fields?.some((f: { label: string }) => f.label === "Current state")).toBe(true);

    record = { ...record, content: "192.0.2.50" };
    const actionId = (staged.result as { actionId: number }).actionId;
    expect(await hooks().apiApply(facet, props(), actionId)).toMatch(/changed after/);
    expect(sent.some(r => r.method === "PATCH")).toBe(false);

    const collected = await actionResult(facet, props(), actionId);
    expect(collected.result).toMatchObject({ status: "failed" });
  });

  it("applies an unchanged edit", async () => {
    const facet = `api-${facets++}`;
    const staged = await call(facet, props(), "dns.records.edit", {
      path: { zone_id: ZONE, dns_record_id: RECORD }, body: { content: "192.0.2.99" },
    });
    const actionId = (staged.result as { actionId: number }).actionId;
    expect(await hooks().apiApply(facet, props(), actionId)).toBeNull();
    expect(record.content).toBe("192.0.2.99");
  });

  it("refuses changes on a read-only binding and other products on a narrowed one", async () => {
    const readOnly = await call(`api-${facets++}`, props({ readOnly: true }),
      "dns.records.create", { path: { zone_id: ZONE }, body: { type: "A" } });
    expect(readOnly.error).toMatch(/read-only/);

    const narrowed = await call(`api-${facets++}`, props({ products: ["workers"] }),
      "dns.records.list", { path: { zone_id: ZONE } });
    expect(narrowed.error).toMatch(/limited to workers/);
    expect(sent).toHaveLength(0);
  });

  it("defaults zone_id on a zone binding and refuses other zones", async () => {
    const zoneProps = props({ zoneName: "example.com" });
    const own = await call(`api-${facets++}`, zoneProps, "dns.records.list");
    expect(own.result).toMatchObject({ status: "ok" });

    const other = await call(`api-${facets++}`, zoneProps, "dns.records.list", {
      path: { zone_id: FOREIGN_ZONE },
    });
    expect(other.error).toMatch(/example.com only/);
  });

  describe("GraphQL Analytics", () => {
    const query = `query ($z: String!) { viewer { zones(filter: { zoneTag: $z }) {
      httpRequests1dGroups(limit: 1) { sum { requests } } } } }`;

    it("sends the rewritten query and returns verified data as an observation", async () => {
      const outcome = await graphql(`api-${facets++}`, props(), query, { z: ZONE });

      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toEqual({
        data: { viewer: { zones: [{ httpRequests1dGroups: [{ sum: { requests: 42 } }] }] } },
      });
      const post = JSON.parse(sent.find(r => r.url.endsWith("/graphql"))!.body!);
      expect(post.query).toContain(`zoneTag: "${ZONE}"`);
      expect(post.variables).toEqual({});
      expect(outcome.observations).toHaveLength(1);
      expect(outcome.observations[0]!.fields?.find(f => f.label === "Zones")).toMatchObject({
        items: ["example.com"],
      });
    });

    it("refuses another account's zone before anything is queried", async () => {
      const outcome = await graphql(`api-${facets++}`, props(), query, { z: FOREIGN_ZONE });

      expect(outcome.error).toMatch(/not in account/);
      expect(sent.some(r => r.url.endsWith("/graphql"))).toBe(false);
    });

    it("withholds a response that carries a row from another zone", async () => {
      graphqlRowTag = FOREIGN_ZONE;
      const outcome = await graphql(`api-${facets++}`, props(), query, { z: ZONE });

      expect(outcome.error).toMatch(/outside this connection/);
      expect(outcome.observations).toHaveLength(0);
    });

    it("needs the analytics product on a narrowed binding", async () => {
      const outcome = await graphql(`api-${facets++}`, props({ products: ["dns"] }), query, { z: ZONE });
      expect(outcome.error).toMatch(/analytics/);
    });
  });
});

describe("who else may see a Cloudflare API binding's reads", () => {
  const verify = (binding: CloudflareApiGatekeeperProps, users: Record<string, TestObserver>, ids: string[]) =>
    hooks().apiVerifyObservers(`api-${facets++}`, binding, users, ids);

  it("reports the subresource on GraphQL reads and on the result of an approved change", async () => {
    const facet = `api-${facets++}`;
    const read = await graphql(facet, props(),
      `{ viewer { zones(filter: { zoneTag: "${ZONE}" }) { httpRequests1dGroups(limit: 1) { sum { requests } } } } }`);
    expect(read.error).toBeUndefined();
    expect(read.observations.map(o => o.subresources)).toEqual([[SUBRESOURCE]]);

    const staged = await call(facet, props(), "dns.records.create", {
      path: { zone_id: ZONE }, body: { type: "A", name: "new.example.com", content: "192.0.2.2" },
    });
    const actionId = (staged.result as { actionId: number }).actionId;
    // Staging returns nothing that was read, so it observes nothing.
    expect(staged.observations).toEqual([]);
    expect(await hooks().apiApply(facet, props(), actionId)).toBeNull();
    const result = await actionResult(facet, props(), actionId);
    expect(result.observations.map(o => o.subresources)).toEqual([[SUBRESOURCE]]);
  });

  it("allows an observer whose own connection is the same Cloudflare user, asking nothing more", async () => {
    expect(await verify(props(), { same: USER }, [SUBRESOURCE])).toEqual(["same"]);
    expect(sent.filter(r => r.url.includes("/memberships"))).toEqual([]);
  });

  it("allows another member only when their access to the account covers the connection's", async () => {
    const observers: Record<string, TestObserver> = {
      same: USER,
      sameGroups: { user: OTHER_USER, membership: { groups: [ADMIN_GROUP] } },
      more: { user: OTHER_USER, membership: { groups: [ADMIN_GROUP, DNS_GROUP].toSorted() } },
      superAdmin: { user: OTHER_USER, membership: { groups: [SUPER_ADMINISTRATOR_GROUP_ID] } },
      less: { user: OTHER_USER, membership: { groups: [DNS_GROUP] } },
      scoped: { user: OTHER_USER, membership: "scoped" },
      notMember: { user: OTHER_USER, membership: "none" },
      noScope: { user: OTHER_USER, membership: "unreadable" },
    };
    expect(await verify(props(), observers, [SUBRESOURCE]))
      .toEqual(["same", "sameGroups", "more", "superAdmin"]);
  });

  it("keeps a read made as another Cloudflare user with that user, whatever the roles", async () => {
    const earlier = `api/account/${ACCOUNT}/user/${OTHER_USER}`;
    const third = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(await verify(props(), {
      thatUser: { user: OTHER_USER, membership: "none" },
      superAdmin: { user: third, membership: { groups: [SUPER_ADMINISTRATOR_GROUP_ID] } },
    }, [earlier])).toEqual(["thatUser"]);
  });

  it("fails the whole call when either membership cannot be read", async () => {
    expect(await verify(props(), {
      broken: { user: OTHER_USER, membership: "!memberships exploded" },
    }, [SUBRESOURCE])).toContain("memberships exploded");
  });

  it("fails the whole call when an observer's user cannot be told", async () => {
    expect(await verify(props(), { same: USER, broken: "!verifier exploded" }, [SUBRESOURCE]))
      .toContain("verifier exploded");
  });

  it("refuses an ID it never reports: telemetry's, another account's, or a malformed one", async () => {
    for (const id of [
      `account/${ACCOUNT}`, `api/account/${OTHER_ACCOUNT}/user/${USER}`, `api/account/${ACCOUNT}`,
      `api/account/${ACCOUNT}/user/${USER.toUpperCase()}`, "global",
    ]) {
      expect(await verify(props(), { same: USER }, [SUBRESOURCE, id]), id)
        .toContain("a resource it never reported");
    }
  });

  it("keeps refusing every collaborator on a binding from before reads reported anything", async () => {
    const facet = `api-${facets++}`;
    expect(await hooks().apiAddObserver(facet, props())).toContain("only be opened by the person who connected it");
    // What that refusal protected is exported, for when the Workshop takes over the history.
    expect(await hooks().apiHistory(facet, props())).toEqual([SUBRESOURCE]);
  });

  it("needs no admission and has no history on a binding minted since", async () => {
    const facet = `api-${facets++}`;
    const binding = props({ reportsSubresources: true });
    expect(await hooks().apiAddObserver(facet, binding)).toBeNull();
    expect(await hooks().apiHistory(facet, binding)).toEqual([]);
  });
});

describe("what a connection may do in an account", () => {
  const seed = async (name: string, token: string, scopes: string[]) => {
    const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromName(name));
    await runInDurableObject(account, (_account, state) => {
      state.storage.kv.put("refreshToken", `refresh-${name}`);
      state.storage.kv.put("accessToken", { token, expires: Date.now() + 3_600_000 });
      state.storage.kv.put("grantedScopes", scopes);
    });
    return account;
  };

  it("reads whole-account permission groups, once per account while fresh", async () => {
    memberships.t1 = [membership(ACCOUNT, [DNS_GROUP.toUpperCase(), ADMIN_GROUP])];
    const account = await seed("member-1", "t1", ["memberships.read"]);
    expect(await account.getAccountMembership(ACCOUNT)).toEqual({ groups: [ADMIN_GROUP, DNS_GROUP] });
    expect(await account.getAccountMembership(ACCOUNT.toUpperCase())).toEqual({ groups: [ADMIN_GROUP, DNS_GROUP] });
    expect(sent.filter(r => r.url.includes("/memberships"))).toHaveLength(1);
    expect(await account.getAccountMembership(OTHER_ACCOUNT)).toBe("none");
  });

  it("does not rank a zone-scoped, pending or unknown-shaped membership", async () => {
    memberships.t2 = [
      membership(ACCOUNT, [ADMIN_GROUP], true),
      { ...membership(OTHER_ACCOUNT, [ADMIN_GROUP]), status: "pending" },
    ];
    const account = await seed("member-2", "t2", ["memberships.read"]);
    expect(await account.getAccountMembership(ACCOUNT)).toBe("scoped");
    expect(await account.getAccountMembership(OTHER_ACCOUNT)).toBe("none");
  });

  it("does not ask without memberships.read, and throws rather than guess when Cloudflare fails", async () => {
    const telemetryOnly = await seed("member-3", "t3", ["workers-observability.read"]);
    expect(await telemetryOnly.getAccountMembership(ACCOUNT)).toBe("unreadable");
    expect(sent.filter(r => r.url.includes("/memberships"))).toEqual([]);

    memberships.t4 = null;
    const down = await seed("member-4", "t4", ["memberships.read"]);
    const failure = await runInDurableObject(down,
      account => account.getAccountMembership(ACCOUNT).then(() => null, e => String(e)));
    expect(failure).toContain("Could not read this connection's Cloudflare memberships");
  });
});

describe("who a connection is", () => {
  it("is asked of Cloudflare once per install of credentials, and never guessed", async () => {
    const id = env.USER_ACCOUNT.idFromName("api-identity");
    const account = env.USER_ACCOUNT.get(id);
    await runInDurableObject(account, (_account, state) => {
      state.storage.kv.put("refreshToken", "refresh-1");
      state.storage.kv.put("accessToken", { token: "access-1", expires: Date.now() + 3_600_000 });
    });
    expect(await account.getCloudflareUserId()).toBe(USER);
    expect(await account.getCloudflareUserId()).toBe(USER);
    expect(sent.filter(r => r.url.endsWith("/user"))).toHaveLength(1);

    const none = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromName("api-nobody"));
    const failure = await runInDurableObject(none, account => account.getCloudflareUserId().then(() => null, e => String(e)));
    expect(failure).toContain("Could not tell which Cloudflare user");
  });
});
