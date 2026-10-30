import { describe, expect, it } from "vitest";
import accountApiConfigurator from "../src/configurator/cloudflare-api-configurator-ui.js";
import OPERATIONS from "../src/api-spec/operations.json";
import { ApiCatalog, type ApiOperation } from "../src/api-spec";
import {
  ACCOUNT_API_RESOURCE, ZONE_API_RESOURCE, apiResourceUrl, bindingReaches, operationRefusal,
  parseApiResourceUrl, pathScopeOf, type ApiBinding,
} from "../src/api-scope";
import { tierOf } from "../src/api-tiers";
import {
  API_SCOPES, apiScopesForResources, grantedResourcePatterns, observabilityScopesForResources,
} from "../src/resources";
import { persistentScopesForResources } from "../src/oauth";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const catalog = new ApiCatalog(OPERATIONS as ApiOperation[], () => ({}));
const op = (name: string) => catalog.get(name)!;

const noUi = new Proxy({}, {
  get() { throw new Error("resourceUrl must not call the ui capability"); },
}) as never;

describe("API resource URLs", () => {
  it("round-trips account and zone bindings", () => {
    const account: ApiBinding = { accountId: ACCOUNT, readOnly: false };
    expect(apiResourceUrl(account)).toBe(`https://dash.cloudflare.com/${ACCOUNT}`);
    expect(parseApiResourceUrl(apiResourceUrl(account))).toEqual(account);

    const zone: ApiBinding = {
      accountId: ACCOUNT, zoneName: "example.com", products: ["rulesets", "dns"], readOnly: true,
    };
    const url = apiResourceUrl(zone);
    expect(url).toBe(`https://dash.cloudflare.com/${ACCOUNT}/example.com#products=dns,rulesets&access=read`);
    expect(parseApiResourceUrl(url)).toEqual({ ...zone, products: ["dns", "rulesets"] });
  });

  it("refuses fragments it does not understand instead of widening the grant", () => {
    expect(() => parseApiResourceUrl(`https://dash.cloudflare.com/${ACCOUNT}#zones=a`)).toThrow();
    expect(() => parseApiResourceUrl(`https://dash.cloudflare.com/${ACCOUNT}#access=write`)).toThrow();
    expect(() => parseApiResourceUrl(`https://dash.cloudflare.com/${ACCOUNT}#products=`)).toThrow();
    expect(() => parseApiResourceUrl(`https://dash.cloudflare.com/${ACCOUNT}?x=1`)).toThrow();
    expect(() => parseApiResourceUrl(`https://dash.cloudflare.com/not-an-account`)).toThrow();
    expect(() => parseApiResourceUrl(`https://dash.cloudflare.com/${ACCOUNT}/no_dots`)).toThrow();
    expect(() => parseApiResourceUrl("https://example.com/x")).toThrow();
  });

  it("keeps the configurator's copy of the grammar in step", () => {
    const values = {
      accountId: ACCOUNT.toUpperCase(), scope: "zone", zoneName: "Example.COM",
      productMode: "choose", products: "waf,dns,dns", access: "read",
    };
    const url = accountApiConfigurator.resourceUrl!({ values, ui: noUi }) as string;
    expect(parseApiResourceUrl(url)).toEqual({
      accountId: ACCOUNT, zoneName: "example.com", products: ["dns", "waf"], readOnly: true,
    });
    const back = accountApiConfigurator.initialValuesFromResourceUrl!({
      resourceUrl: url, resourceUrlPattern: ZONE_API_RESOURCE.urlPattern, ui: noUi,
    });
    expect(back).toMatchObject({ scope: "zone", zoneName: "example.com", access: "read" });

    const accountUrl = accountApiConfigurator.resourceUrl!({
      values: { accountId: ACCOUNT, scope: "account", productMode: "all", access: "change" }, ui: noUi,
    }) as string;
    expect(accountUrl).toBe(apiResourceUrl({ accountId: ACCOUNT, readOnly: false }));
  });

  it("matches the patterns the OAuth scope mapping knows", () => {
    const patterns = [ACCOUNT_API_RESOURCE.urlPattern, ZONE_API_RESOURCE.urlPattern];
    expect(grantedResourcePatterns(["zone.read"])).toEqual(patterns);
    expect(apiScopesForResources(patterns, false)).toEqual(API_SCOPES);
    expect(observabilityScopesForResources(patterns)).toEqual([]);
  });

  it("asks for API scopes on 'connect all' only when the deployment offers the resource", () => {
    expect(persistentScopesForResources(undefined, false)).not.toContain("zone.read");
    expect(persistentScopesForResources(undefined, true)).toContain("zone.read");
    expect(persistentScopesForResources([ZONE_API_RESOURCE.urlPattern], false)).toContain("dns.write");
  });
});

describe("binding checks", () => {
  const account: ApiBinding = { accountId: ACCOUNT, readOnly: false };
  const zone: ApiBinding = { accountId: ACCOUNT, zoneName: "example.com", readOnly: false };

  it("classifies paths by their account or zone", () => {
    expect(pathScopeOf(op("dns.records.list"), { zone_id: "z" })).toEqual({ kind: "zone", zoneId: "z" });
    expect(pathScopeOf(op("workers.legacy.scripts.list"), { account_id: ACCOUNT }))
      .toEqual({ kind: "account", accountId: ACCOUNT });
    expect(pathScopeOf(op("zones.list"), {})).toEqual({ kind: "zones-root" });
    expect(pathScopeOf(op("ips.list"), {})).toEqual({ kind: "public" });
    expect(pathScopeOf(op("user.get"), {})).toEqual({ kind: "outside" });
  });

  it("refuses operations outside every account", () => {
    const user = op("user.get");
    expect(operationRefusal(account, user, tierOf(user), pathScopeOf(user, {}))).toMatch(/not part/);
    expect(bindingReaches(account, op("accounts.list"), "read")).toBe(false);
  });

  it("keeps zone bindings off account-level operations", () => {
    expect(bindingReaches(zone, op("workers.legacy.scripts.list"), "read")).toBe(false);
    expect(bindingReaches(zone, op("zones.list"), "read")).toBe(false);
    expect(bindingReaches(zone, op("dns.records.list"), "read")).toBe(true);
    expect(bindingReaches(account, op("dns.records.list"), "read")).toBe(true);
  });

  it("applies product and read-only narrowing", () => {
    const narrowed: ApiBinding = { ...account, products: ["dns"], readOnly: true };
    expect(bindingReaches(narrowed, op("dns.records.list"), "read")).toBe(true);
    expect(bindingReaches(narrowed, op("dns.records.create"), "write")).toBe(false);
    expect(bindingReaches(narrowed, op("workers.legacy.scripts.list"), "read")).toBe(false);
  });

  it("never reaches blocked operations", () => {
    expect(bindingReaches(account, op("tunnels.token.get"), "blocked")).toBe(false);
  });
});
