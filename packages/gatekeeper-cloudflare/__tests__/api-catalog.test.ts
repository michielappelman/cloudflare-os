// The catalog and tier rules over the real generated index. These tests double as drift guards:
// when a spec refresh renames a command a reviewed list depends on, they fail rather than letting
// the list silently stop matching.

import { describe, expect, it } from "vitest";
import OPERATIONS from "../src/api-spec/operations.json";
import SCHEMAS from "../src/api-spec/schemas.txt?raw";
import TIERS_SOURCE from "../src/api-tiers.ts?raw";
import {
  ApiCatalog, fillPath, splitConcretePath, type ApiOperation, type ApiOperationSchema,
} from "../src/api-spec";
import { isAction, tierOf } from "../src/api-tiers";

const catalog = new ApiCatalog(OPERATIONS as ApiOperation[],
  () => JSON.parse(SCHEMAS) as Record<string, ApiOperationSchema>);

const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";

function op(idOrCommand: string): ApiOperation {
  const found = catalog.get(idOrCommand);
  if (!found) throw new Error(`missing ${idOrCommand}`);
  return found;
}

describe("ApiCatalog", () => {
  it("indexes every operation by id and unique command", () => {
    expect(catalog.size).toBeGreaterThan(3000);
    expect(op("dns.records.create")).toBe(op("dns-records-for-a-zone-create-dns-record"));
    expect(op("dns.records.create")).toMatchObject({
      method: "POST", path: "/zones/{zone_id}/dns_records", product: "dns", body: "json",
    });
  });

  it("resolves a concrete path to its operation and decodes parameters", () => {
    const resolved = catalog.resolve("get", `/zones/${ZONE}/dns_records/abc%20def`);
    expect(resolved?.operation.command).toBe("dns.records.get");
    expect(resolved?.pathParams).toEqual({ zone_id: ZONE, dns_record_id: "abc def" });
  });

  it("prefers the template with more literal segments", () => {
    const resolved = catalog.resolve("GET", `/zones/${ZONE}/dns_records/export`);
    expect(resolved?.operation.command).toBe("dns.records.export");
  });

  it("refuses traversal, encoded slashes and query strings in paths", () => {
    expect(() => splitConcretePath("/zones/../accounts")).toThrow();
    expect(() => splitConcretePath("/zones/a%2Fb")).toThrow();
    expect(() => splitConcretePath("/zones?x=1")).toThrow(/query/);
    expect(() => splitConcretePath("zones")).toThrow();
    expect(catalog.resolve("GET", "/no/such/path")).toBeUndefined();
  });

  it("fills path templates with encoded values and refuses traversal", () => {
    expect(fillPath("/zones/{zone_id}/x/{name}", { zone_id: ZONE, name: "a b" }))
      .toBe(`/zones/${ZONE}/x/a%20b`);
    expect(() => fillPath("/zones/{zone_id}", {})).toThrow(/zone_id/);
    expect(() => fillPath("/zones/{zone_id}", { zone_id: ".." })).toThrow();
    expect(() => fillPath("/zones/{zone_id}", { zone_id: "a/b" })).toThrow();
  });

  it("finds the GET on the same path as a change", () => {
    expect(catalog.readerFor(op("dns.records.edit"))?.command).toBe("dns.records.get");
    expect(catalog.readerFor(op("dns.records.get"))).toBeUndefined();
  });

  it("ranks search results and applies the filter first", () => {
    const results = catalog.search("dns record create");
    expect(results[0]?.command).toBe("dns.records.create");
    const readsOnly = catalog.search("dns record", { filter: o => o.method === "GET" });
    expect(readsOnly.every(o => o.method === "GET")).toBe(true);
    expect(catalog.search("dns", { limit: 500 }).length).toBeLessThanOrEqual(50);
    expect(() => catalog.search("  ")).toThrow();
    expect(() => catalog.search("x".repeat(201))).toThrow();
  });

  it("loads per-operation detail on demand", () => {
    const schema = catalog.schema(op("dns.records.create").id);
    expect(schema.params.map(p => p.name)).toContain("zone_id");
    expect(schema.body).toContain("content");
    expect(schema.result).toBeDefined();
  });
});

describe("tierOf", () => {
  it("treats GETs as reads and ordinary changes as writes", () => {
    expect(tierOf(op("dns.records.list"))).toBe("read");
    expect(tierOf(op("dns.records.create"))).toBe("write");
    expect(tierOf(op("dns.records.edit"))).toBe("write");
  });

  it("marks deletes and Cloudflare-confirmed operations destructive", () => {
    expect(tierOf(op("dns.records.delete"))).toBe("destructive");
    const confirmed = [...catalog.all()].find(o => o.confirm && o.method === "POST"
      && !tierOf(o).startsWith("privileged"));
    expect(confirmed && tierOf(confirmed)).toBe("destructive");
  });

  it("marks identity, credential and billing changes privileged, but keeps their reads", () => {
    expect(tierOf(op("accounts.tokens.create"))).toBe("privileged");
    expect(tierOf(op("accounts.members.create"))).toBe("privileged");
    expect(tierOf(op("accounts.members.list"))).toBe("read");
    expect(tierOf(op("zero-trust.access.service-tokens.create"))).toBe("privileged");
    expect(tierOf(op("accounts.update"))).toBe("privileged");
  });

  it("blocks operations that return a live credential", () => {
    expect(tierOf(op("tunnels.token.get"))).toBe("blocked");
    expect(tierOf(op("r2.temporary-credentials.create"))).toBe("blocked");
  });

  it("reads through the reviewed read-only POSTs, and not D1 queries", () => {
    expect(tierOf(op("logs.query"))).toBe("read");
    expect(tierOf(op("analytics-engine.sql.query"))).toBe("read");
    expect(isAction(tierOf(op("d1.query")))).toBe(true);
  });

  it("names only commands that exist in the catalog", () => {
    // Every command or prefix the reviewed lists name must still exist after a spec refresh.
    const listed = [...TIERS_SOURCE.matchAll(/^\s+"([a-z0-9-]+(?:\.[a-z0-9-]+)+)",$/gm)].map(m => m[1]!);
    expect(listed.length).toBeGreaterThan(30);
    const commands = [...catalog.all()].map(o => o.command ?? "");
    const missing = listed.filter(name =>
      !commands.some(command => command === name || command.startsWith(`${name}.`)));
    expect(missing).toEqual([]);
  });
});
