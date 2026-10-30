import { describe, expect, it, vi } from "vitest";
import OPERATIONS from "../src/api-spec/operations.json";
import { ApiCatalog, type ApiOperation } from "../src/api-spec";
import {
  CloudflareApiClient, CloudflareApiError, encodeBody, provesNotApplied,
} from "../src/api-client";
import { describeChange, describeRead } from "../src/api-describe";
import { REDACTED, redactResult } from "../src/api-redact";
import { tierOf } from "../src/api-tiers";

const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const catalog = new ApiCatalog(OPERATIONS as ApiOperation[], () => ({}));
const op = (name: string) => catalog.get(name)!;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

describe("CloudflareApiClient", () => {
  it("sends the catalog path with the bearer token and unwraps the envelope", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, {
      success: true, errors: [], result: [{ id: "r1" }], result_info: { page: 1, per_page: 1 },
    }));
    const client = new CloudflareApiClient(async () => "tok", fetcher as unknown as typeof fetch);
    const response = await client.send(op("dns.records.list"), {
      pathParams: { zone_id: ZONE }, query: { type: ["A", "AAAA"], proxied: true },
    });
    expect(fetcher.mock.calls[0]![0]).toBe(
      `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records?type=A&type=AAAA&proxied=true`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "GET", headers: { Authorization: "Bearer tok" },
    });
    expect(response).toEqual({ status: 200, result: [{ id: "r1" }], resultInfo: { page: 1, per_page: 1 } });
  });

  it("carries Cloudflare's codes and messages on failure", async () => {
    const client = new CloudflareApiClient(async () => "tok", (async () => jsonResponse(400, {
      success: false, errors: [{ code: 9005, message: "Content for A record is invalid." }],
    })) as unknown as typeof fetch);
    const error = await client.send(op("dns.records.list"), { pathParams: { zone_id: ZONE } })
      .catch((e: unknown) => e) as CloudflareApiError;
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error).toMatchObject({ status: 400, codes: [9005], fromProvider: true });
    expect(error.message).toContain("Content for A record is invalid.");
    expect(provesNotApplied(error)).toBe(true);
    expect(provesNotApplied(new CloudflareApiError(502, "x"))).toBe(false);
    expect(provesNotApplied(new TypeError("network"))).toBe(false);
  });

  it("asks for a reconnect when the token is gone", async () => {
    const client = new CloudflareApiClient(async () => null, vi.fn() as unknown as typeof fetch);
    await expect(client.send(op("dns.records.list"), { pathParams: { zone_id: ZONE } }))
      .rejects.toMatchObject({ status: 401 });
  });

  it("refuses query values that are not scalars", () => {
    expect(() => CloudflareApiClient.url(op("dns.records.list"), {
      pathParams: { zone_id: ZONE }, query: { x: { y: 1 } as never },
    })).toThrow(/Query parameter/);
  });
});

describe("encodeBody", () => {
  it("serializes JSON bodies once and enforces presence", () => {
    expect(encodeBody(op("dns.records.create"), { type: "A" })).toBe('{"type":"A"}');
    expect(() => encodeBody(op("dns.records.create"), undefined)).toThrow(/requires a request body/);
    expect(() => encodeBody(op("dns.records.list"), { x: 1 })).toThrow(/takes no request body/);
    const upload = [...catalog.all()].find(o => o.body && o.body !== "json")!;
    expect(() => encodeBody(upload, {})).toThrow(/cannot send yet/);
  });
});

describe("redactResult", () => {
  it("replaces secret fields wherever they appear", () => {
    const result = redactResult(op("zero-trust.identity-providers.get"), {
      id: "idp", config: { client_id: "abc", client_secret: "shh" }, nested: [{ token: "t" }],
    });
    expect(result).toEqual({
      id: "idp", config: { client_id: "abc", client_secret: REDACTED }, nested: [{ token: REDACTED }],
    });
  });

  it("treats a new API token's value as a secret", () => {
    expect(redactResult(op("accounts.tokens.create"), { id: "t", value: "secret" }))
      .toEqual({ id: "t", value: REDACTED });
    expect(redactResult(op("dns.records.get"), { value: "kept" })).toEqual({ value: "kept" });
  });
});

function call(name: string, extra: object = {}) {
  const operation = op(name);
  return {
    operation, tier: tierOf(operation), target: "account x",
    url: `https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records`,
    pathParams: { zone_id: ZONE }, zone: { id: ZONE, name: "example.com" }, ...extra,
  };
}

describe("descriptions", () => {

  it("makes ordinary writes auto-approvable per product", () => {
    const description = describeChange(call("dns.records.create", { bodyText: '{"type":"A"}' }));
    expect(description).toMatchObject({
      autoApprovable: true,
      awaitDecision: true,
      implementsRevert: false,
      actionKind: { tag: "cloudflare.api.dns" },
      descriptionIsComplete: true,
    });
    expect(description.fields?.map(f => f.label)).toEqual(
      ["Request", "Zone", "Path: zone_id", "Request body"]);
  });

  it("never makes destructive or privileged changes auto-approvable", () => {
    for (const name of ["dns.records.delete", "accounts.tokens.create"]) {
      const description = describeChange(call(name));
      expect(description.autoApprovable).toBeUndefined();
      expect(description.actionKind).toBeUndefined();
    }
  });

  it("shows the state being replaced", () => {
    const description = describeChange(call("dns.records.edit", { bodyText: "{}" }), { content: "old" });
    expect(description.fields?.find(f => f.label === "Current state")).toBeDefined();
    expect(description.description).toContain("will not be made");
  });

  it("records the request of a read", () => {
    const observation = describeRead(call("dns.records.list"), "returned 2 item(s)");
    expect(observation.description).toContain("returned 2 item(s)");
    expect(observation.fields?.[0]).toMatchObject({ label: "Request", kind: "inline" });
  });
});
