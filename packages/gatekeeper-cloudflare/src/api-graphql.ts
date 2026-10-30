// Scoping for the GraphQL Analytics API (`POST /client/v4/graphql`).
//
// Unlike a REST path, a GraphQL query names the accounts and zones it reads inside its own text:
// `viewer { zones(filter: { zoneTag: "…" }) { … } }`. A query that left the filter out, or used
// `zoneTag_in`, `OR`, or a variable holding another account's zone, would read whatever the
// credential can reach. So the query is parsed and held to a narrow shape:
//
//   - one `query` operation, no fragments, nothing at the top level but `viewer` (or, for
//     exploring the schema, only `__schema` / `__type`);
//   - under `viewer`, only `zones`, `accounts`, `budget` and `__typename`;
//   - every `zones` / `accounts` filter is reduced to the tags it names, checked, and *rewritten*
//     to a literal the gatekeeper wrote, so no variable or extra condition reaches the scope;
//   - each `zones` / `accounts` selection gets a hidden `zoneTag` / `accountTag` field, and every
//     row of the response is checked against the allowed tags before anything is returned.
//
// Everything here is pure; whether a zone tag belongs to the bound account is the host's check.

import {
  Kind, parse, print, visit,
  type ArgumentNode, type DocumentNode, type FieldNode, type ObjectFieldNode,
  type OperationDefinitionNode, type SelectionNode, type ValueNode,
} from "graphql/language";

/** Longest query text accepted, in characters. */
export const MAX_GRAPHQL_QUERY = 16 * 1024;
/** Longest JSON encoding of the variables accepted, in characters. */
export const MAX_GRAPHQL_VARIABLES = 16 * 1024;
const MAX_TOKENS = 4000;
const MAX_TAGS = 50;
const TAG_PATTERN = /^[a-f0-9]{32}$/i;

/** The hidden alias each scoped selection gets; a caller may not use it. */
export const SCOPE_ALIAS = "_cfosScopeTag";

const VIEWER_FIELDS = new Set(["zones", "accounts", "budget", "__typename"]);
const INTROSPECTION_FIELDS = new Set(["__schema", "__type", "__typename"]);

/** What a GraphQL query may reach. */
export interface GraphqlBinding {
  accountId: string;
  /** Set on a zone binding: the only zone a query may read. */
  zoneId?: string;
}

/** One scoped selection, to check in the response. */
export interface ScopeCheck {
  viewerKey: string;
  fieldKey: string;
  kind: "zone" | "account";
  /** Lowercased tags the rows may carry. */
  allowed: string[];
}

/** A query rewritten to stay inside the binding. */
export interface ScopedGraphql {
  query: string;
  variables: Record<string, unknown>;
  /** Zone tags the query reads, which the host must confirm belong to the bound account. */
  zoneTags: string[];
  checks: ScopeCheck[];
  /** True for a query that only reads the schema (`__schema` / `__type`). */
  introspection: boolean;
}

function refuse(message: string): never {
  throw new Error(`GraphQL query refused: ${message}`);
}

function keyOf(field: FieldNode): string {
  return field.alias?.value ?? field.name.value;
}

function fieldsOf(selections: readonly SelectionNode[], where: string): FieldNode[] {
  return selections.map(selection => {
    if (selection.kind !== Kind.FIELD) refuse(`fragments are not supported (${where}).`);
    return selection;
  });
}

/** Resolves a value node to plain JSON, reading variables. Only what a filter needs. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case Kind.VARIABLE: return variables[node.name.value];
    case Kind.STRING: return node.value;
    case Kind.LIST: return node.values.map(value => valueOf(value, variables));
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((field: ObjectFieldNode) =>
        [field.name.value, valueOf(field.value, variables)]));
    case Kind.NULL: return null;
    default: return refuse("scope filters take string tags only.");
  }
}

/** Reads the tags a `zones` / `accounts` filter names, refusing every other condition. */
function filterTags(field: FieldNode, tagKey: "zoneTag" | "accountTag",
    variables: Record<string, unknown>): string[] | undefined {
  const args = field.arguments ?? [];
  for (const arg of args) {
    if (arg.name.value !== "filter") refuse(`${field.name.value} takes only a filter argument.`);
  }
  const filterArg = args.find(arg => arg.name.value === "filter");
  if (!filterArg) return undefined;
  const filter = valueOf(filterArg.value, variables);
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    refuse(`${field.name.value}(filter:) must be an object.`);
  }
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.length !== 1) {
    refuse(`${field.name.value}(filter:) must have exactly one of ${tagKey} or ${tagKey}_in.`);
  }
  const [key, value] = entries[0]!;
  const tags = key === tagKey ? [value] : key === `${tagKey}_in` && Array.isArray(value) ? value
    : refuse(`${field.name.value}(filter:) must have exactly one of ${tagKey} or ${tagKey}_in.`);
  if (tags.length === 0 || tags.length > MAX_TAGS) refuse(`name 1 to ${MAX_TAGS} tags.`);
  return tags.map(tag => {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) refuse(`${tagKey} must be a 32-character id.`);
    return tag.toLowerCase();
  });
}

function literalFilter(tagKey: "zoneTag" | "accountTag", tags: string[]): ArgumentNode {
  const value: ValueNode = tags.length === 1
    ? { kind: Kind.STRING, value: tags[0]! }
    : { kind: Kind.LIST, values: tags.map(tag => ({ kind: Kind.STRING, value: tag })) };
  return {
    kind: Kind.ARGUMENT,
    name: { kind: Kind.NAME, value: "filter" },
    value: {
      kind: Kind.OBJECT,
      fields: [{
        kind: Kind.OBJECT_FIELD,
        name: { kind: Kind.NAME, value: tags.length === 1 ? tagKey : `${tagKey}_in` },
        value,
      }],
    },
  };
}

function withScopeTag(field: FieldNode, tagKey: "zoneTag" | "accountTag", args: ArgumentNode[]): FieldNode {
  const selections = field.selectionSet?.selections ?? [];
  return {
    ...field,
    arguments: args,
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections: [...selections, {
        kind: Kind.FIELD,
        alias: { kind: Kind.NAME, value: SCOPE_ALIAS },
        name: { kind: Kind.NAME, value: tagKey },
      }],
    },
  };
}

/**
 * Parses, checks and rewrites a query for one binding.
 * @throws When the query has any shape outside the rules above.
 */
export function scopeGraphqlQuery(query: string, variables: Record<string, unknown> | undefined,
    binding: GraphqlBinding): ScopedGraphql {
  if (typeof query !== "string" || query.trim() === "") refuse("the query is empty.");
  if (query.length > MAX_GRAPHQL_QUERY) refuse(`queries are limited to ${MAX_GRAPHQL_QUERY} characters.`);
  const vars = variables ?? {};
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) refuse("variables must be an object.");
  if ((JSON.stringify(vars) ?? "").length > MAX_GRAPHQL_VARIABLES) {
    refuse(`variables are limited to ${MAX_GRAPHQL_VARIABLES} characters.`);
  }

  let document: DocumentNode;
  try {
    document = parse(query, { noLocation: true, maxTokens: MAX_TOKENS });
  } catch (error) {
    return refuse((error as Error).message);
  }
  if (document.definitions.length !== 1 || document.definitions[0]!.kind !== Kind.OPERATION_DEFINITION) {
    refuse("send exactly one operation and no fragment definitions.");
  }
  const operation = document.definitions[0] as OperationDefinitionNode;
  if (operation.operation !== "query") refuse("only queries are allowed.");
  if (operation.directives?.length) refuse("directives on the operation are not supported.");
  visit(document, {
    FragmentSpread() { refuse("fragments are not supported."); },
    InlineFragment() { refuse("fragments are not supported."); },
    Field(node) { if (node.alias?.value === SCOPE_ALIAS) refuse(`the alias ${SCOPE_ALIAS} is reserved.`); },
  });

  const top = fieldsOf(operation.selectionSet.selections, "top level");
  if (top.every(field => INTROSPECTION_FIELDS.has(field.name.value))) {
    return { query: print(document), variables: vars, zoneTags: [], checks: [], introspection: true };
  }

  const zoneTags = new Set<string>();
  const checks: ScopeCheck[] = [];
  const account = binding.accountId.toLowerCase();
  const rewrittenTop = top.map(viewer => {
    if (viewer.name.value === "__typename") return viewer;
    if (viewer.name.value !== "viewer") {
      refuse(`the top level may contain only viewer (or only __schema / __type), not ${viewer.name.value}.`);
    }
    if (viewer.arguments?.length || viewer.directives?.length) refuse("viewer takes no arguments or directives.");
    const inner = fieldsOf(viewer.selectionSet?.selections ?? [], "viewer");
    const rewritten = inner.map(field => {
      const name = field.name.value;
      if (!VIEWER_FIELDS.has(name)) refuse(`viewer may contain only zones, accounts and budget, not ${name}.`);
      if (name !== "zones" && name !== "accounts") return field;
      if (field.directives?.length) refuse(`directives on ${name} are not supported.`);

      if (name === "zones") {
        let tags = filterTags(field, "zoneTag", vars);
        if (binding.zoneId) {
          const bound = binding.zoneId.toLowerCase();
          tags ??= [bound];
          if (tags.some(tag => tag !== bound)) refuse("this connection covers one zone only.");
        } else if (!tags) {
          refuse("zones needs filter: { zoneTag: \"…\" } or { zoneTag_in: [...] }.");
        }
        for (const tag of tags) zoneTags.add(tag);
        checks.push({ viewerKey: keyOf(viewer), fieldKey: keyOf(field), kind: "zone", allowed: tags });
        return withScopeTag(field, "zoneTag", [literalFilter("zoneTag", tags)]);
      }

      if (binding.zoneId) refuse("account datasets are not available on a zone connection.");
      const tags = filterTags(field, "accountTag", vars) ?? [account];
      if (tags.some(tag => tag !== account)) refuse(`this connection covers account ${binding.accountId} only.`);
      checks.push({ viewerKey: keyOf(viewer), fieldKey: keyOf(field), kind: "account", allowed: [account] });
      return withScopeTag(field, "accountTag", [literalFilter("accountTag", [account])]);
    });
    return { ...viewer, selectionSet: { kind: Kind.SELECTION_SET, selections: rewritten } } as FieldNode;
  });

  // Variables the rewrite inlined are no longer used, and GraphQL rejects an unused variable.
  const rewrittenOperation: OperationDefinitionNode = {
    ...operation,
    selectionSet: { kind: Kind.SELECTION_SET, selections: rewrittenTop },
  };
  const used = new Set<string>();
  visit(rewrittenOperation.selectionSet, { Variable(node) { used.add(node.name.value); } });
  const definitions = (operation.variableDefinitions ?? [])
    .filter(definition => used.has(definition.variable.name.value));
  const finalOperation = { ...rewrittenOperation, variableDefinitions: definitions };
  const keptVariables = Object.fromEntries(Object.entries(vars).filter(([key]) => used.has(key)));

  return {
    query: print({ kind: Kind.DOCUMENT, definitions: [finalOperation] }),
    variables: keptVariables,
    zoneTags: [...zoneTags],
    checks,
    introspection: false,
  };
}

/**
 * Checks every scoped row of a response against the tags the query was allowed, and removes the
 * hidden tag field. One foreign row means the scope did not hold, so nothing is returned.
 */
export function verifyGraphqlData(data: unknown, checks: readonly ScopeCheck[]): unknown {
  if (data === null || data === undefined) return data;
  for (const check of checks) {
    const viewer = (data as Record<string, unknown>)[check.viewerKey];
    if (viewer === null || viewer === undefined) continue;
    const rows = (viewer as Record<string, unknown>)[check.fieldKey];
    if (rows === null || rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error("Cloudflare returned an unexpected GraphQL response shape.");
    for (const row of rows as Array<Record<string, unknown>>) {
      const tag = row?.[SCOPE_ALIAS];
      if (typeof tag !== "string" || !check.allowed.includes(tag.toLowerCase())) {
        throw new Error("Cloudflare returned GraphQL data outside this connection, so none of it " +
          "is returned.");
      }
      delete row[SCOPE_ALIAS];
    }
  }
  return data;
}

/** The introspection query `describeGraphqlType()` sends for one type. */
export function typeQuery(): string {
  const typeRef = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
  return `query ($name: String!) { __type(name: $name) { name kind description
    fields { name description args { name description type { ${typeRef} } } type { ${typeRef} } }
    inputFields { name description type { ${typeRef} } }
    enumValues { name description } } }`;
}

/** The introspection query for the root query type's name. */
export const ROOT_TYPE_QUERY = "{ __schema { queryType { name } } }";
