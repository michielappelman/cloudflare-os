// The Cloudflare API binding end to end, through the real Durable Object and a fake Cloudflare API:
// reads are observed, changes are only sent once approved, a change to a resource that moved since
// it was requested is refused, and nothing outside the bound account is reachable.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareApiGatekeeperProps } from "../../src/api-gatekeeper.js";
import type { CloudflareApiRequest } from "../../src/api-types.js";
import type { ApiCallOutcome } from "../worker.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const FOREIGN_ZONE = "99999999999999999999999999999999";
const RECORD = "372e67954025e0ba6aaa6d586b9e0b59";
const API = "https://api.cloudflare.com/client/v4";

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
  });
});

beforeEach(() => {
  record = { id: RECORD, type: "A", name: "www.example.com", content: "192.0.2.1" };
  graphqlRowTag = ZONE;
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
