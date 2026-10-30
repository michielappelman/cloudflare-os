// The GraphQL scoper is the only thing between a query's text and every zone the credential can
// read, so most of these tests are attempts to get around it.

import { describe, expect, it } from "vitest";
import { parse } from "graphql/language";
import { SCOPE_ALIAS, scopeGraphqlQuery, verifyGraphqlData } from "../src/api-graphql";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const ZONE_2 = "11111111111111111111111111111111";
const account = { accountId: ACCOUNT };
const zoneBinding = { accountId: ACCOUNT, zoneId: ZONE };

const DATASET = "httpRequests1dGroups(limit: 1) { sum { requests } }";

describe("scopeGraphqlQuery", () => {
  it("rewrites a variable zone filter to a literal and adds the scope tag", () => {
    const scoped = scopeGraphqlQuery(
      `query ($z: String!, $since: Date!) { viewer { zones(filter: { zoneTag: $z }) {
         httpRequests1dGroups(limit: 1, filter: { date_geq: $since }) { sum { requests } } } } }`,
      { z: ZONE.toUpperCase(), since: "2026-10-01" }, account);

    expect(scoped.zoneTags).toEqual([ZONE]);
    expect(scoped.variables).toEqual({ since: "2026-10-01" });
    expect(scoped.query).toContain(`zones(filter: { zoneTag: "${ZONE}" })`);
    expect(scoped.query).toContain(`${SCOPE_ALIAS}: zoneTag`);
    expect(scoped.query).not.toContain("$z");
    expect(scoped.checks).toEqual([{ viewerKey: "viewer", fieldKey: "zones", kind: "zone", allowed: [ZONE] }]);
    // The rewritten text is still valid GraphQL.
    expect(() => parse(scoped.query)).not.toThrow();
  });

  it("accepts zoneTag_in and a whole filter passed as a variable", () => {
    const scoped = scopeGraphqlQuery(`query ($f: ZoneFilter_InputObject) {
      viewer { zones(filter: $f) { ${DATASET} } } }`, { f: { zoneTag_in: [ZONE, ZONE_2] } }, account);
    expect(scoped.zoneTags).toEqual([ZONE, ZONE_2]);
    expect(scoped.query).toContain(`zoneTag_in: ["${ZONE}", "${ZONE_2}"]`);
    expect(scoped.variables).toEqual({});
  });

  it("refuses a zones selection without a filter on an account binding", () => {
    expect(() => scopeGraphqlQuery(`{ viewer { zones { ${DATASET} } } }`, {}, account))
      .toThrow(/zones needs filter/);
  });

  it("fills in the bound zone and refuses any other on a zone binding", () => {
    const scoped = scopeGraphqlQuery(`{ viewer { zones { ${DATASET} } } }`, {}, zoneBinding);
    expect(scoped.query).toContain(`zoneTag: "${ZONE}"`);
    expect(() => scopeGraphqlQuery(`{ viewer { zones(filter: { zoneTag: "${ZONE_2}" }) { ${DATASET} } } }`,
      {}, zoneBinding)).toThrow(/one zone only/);
    expect(() => scopeGraphqlQuery(`{ viewer { zones(filter: { zoneTag_in: ["${ZONE}", "${ZONE_2}"] }) {
      ${DATASET} } } }`, {}, zoneBinding)).toThrow(/one zone only/);
  });

  it("refuses every filter condition other than the tag", () => {
    for (const filter of [
      `{ zoneTag: "${ZONE}", OR: [{ zoneTag: "${ZONE_2}" }] }`,
      `{ OR: [{ zoneTag: "${ZONE}" }] }`,
      `{ zoneTag_neq: "${ZONE}" }`,
      `{ zoneTag_gt: "0" }`,
      `{}`,
      `{ zoneTag: "not-a-tag" }`,
    ]) {
      expect(() => scopeGraphqlQuery(`{ viewer { zones(filter: ${filter}) { ${DATASET} } } }`, {}, account),
        filter).toThrow(/refused/);
    }
  });

  it("refuses extra arguments, directives and a missing variable value", () => {
    expect(() => scopeGraphqlQuery(`{ viewer { zones(filter: { zoneTag: "${ZONE}" }, limit: 5) {
      ${DATASET} } } }`, {}, account)).toThrow(/only a filter/);
    expect(() => scopeGraphqlQuery(`query ($s: Boolean!) { viewer { zones(filter: { zoneTag: "${ZONE}" }) @skip(if: $s) {
      ${DATASET} } } }`, { s: false }, account)).toThrow(/directives/);
    expect(() => scopeGraphqlQuery(`query ($z: String) { viewer { zones(filter: { zoneTag: $z }) {
      ${DATASET} } } }`, {}, account)).toThrow(/32-character/);
  });

  it("pins accounts to the bound account and refuses them on a zone binding", () => {
    const scoped = scopeGraphqlQuery(`{ viewer { accounts { workersInvocationsAdaptive(limit: 1) {
      sum { requests } } } } }`, {}, account);
    expect(scoped.query).toContain(`accounts(filter: { accountTag: "${ACCOUNT}" })`);
    expect(() => scopeGraphqlQuery(`{ viewer { accounts(filter: { accountTag: "${ZONE_2}" }) {
      x } } }`, {}, account)).toThrow(/account/);
    expect(() => scopeGraphqlQuery(`{ viewer { accounts { x } } }`, {}, zoneBinding))
      .toThrow(/not available on a zone connection/);
  });

  it("refuses fragments, mutations, several operations and unknown top-level fields", () => {
    const refused = [
      `fragment F on zone { ${DATASET} } { viewer { zones(filter: { zoneTag: "${ZONE}" }) { ...F } } }`,
      `{ viewer { ... on viewer { zones { ${DATASET} } } } }`,
      `mutation { viewer { x } }`,
      `query A { viewer { budget } } query B { viewer { budget } }`,
      `{ somethingElse { x } }`,
      `{ viewer { budget } __schema { types { name } } }`,
      `{ viewer { organizations { x } } }`,
      `{ viewer(as: "other") { budget } }`,
      `{ viewer { zones(filter: { zoneTag: "${ZONE}" }) { ${SCOPE_ALIAS}: zoneTag } } }`,
    ];
    for (const query of refused) {
      expect(() => scopeGraphqlQuery(query, {}, account), query).toThrow(/refused/);
    }
  });

  it("refuses oversized and unparseable input", () => {
    expect(() => scopeGraphqlQuery("{".repeat(20_000), {}, account)).toThrow(/limited/);
    expect(() => scopeGraphqlQuery("{ viewer {", {}, account)).toThrow(/Syntax Error/);
    expect(() => scopeGraphqlQuery("{ viewer { budget } }", { x: "y".repeat(20_000) }, account))
      .toThrow(/variables are limited/);
  });

  it("passes schema-only queries through without scope checks", () => {
    const scoped = scopeGraphqlQuery(`{ __type(name: "zone") { name } }`, {}, account);
    expect(scoped.introspection).toBe(true);
    expect(scoped.checks).toEqual([]);
  });

  it("checks aliased viewers and fields separately", () => {
    const scoped = scopeGraphqlQuery(`{ a: viewer { z1: zones(filter: { zoneTag: "${ZONE}" }) { ${DATASET} } }
      b: viewer { z2: zones(filter: { zoneTag: "${ZONE_2}" }) { ${DATASET} } } }`, {}, account);
    expect(scoped.checks.map(c => `${c.viewerKey}.${c.fieldKey}`)).toEqual(["a.z1", "b.z2"]);
    expect(scoped.zoneTags).toEqual([ZONE, ZONE_2]);
  });
});

describe("verifyGraphqlData", () => {
  const checks = [{ viewerKey: "viewer", fieldKey: "zones", kind: "zone" as const, allowed: [ZONE] }];

  it("strips the scope tag from rows that belong to the binding", () => {
    const data = { viewer: { zones: [{ x: 1, [SCOPE_ALIAS]: ZONE.toUpperCase() }] } };
    expect(verifyGraphqlData(data, checks)).toEqual({ viewer: { zones: [{ x: 1 }] } });
  });

  it("withholds everything when one row is foreign or untagged", () => {
    expect(() => verifyGraphqlData({ viewer: { zones: [{ [SCOPE_ALIAS]: ZONE_2 }] } }, checks))
      .toThrow(/outside this connection/);
    expect(() => verifyGraphqlData({ viewer: { zones: [{ x: 1 }] } }, checks))
      .toThrow(/outside this connection/);
    expect(() => verifyGraphqlData({ viewer: { zones: { x: 1 } } }, checks)).toThrow(/unexpected/);
  });

  it("tolerates null data and missing selections, as GraphQL returns on errors", () => {
    expect(verifyGraphqlData(null, checks)).toBeNull();
    expect(verifyGraphqlData({ viewer: null }, checks)).toEqual({ viewer: null });
  });
});
