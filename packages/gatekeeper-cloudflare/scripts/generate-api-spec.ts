// Compiles Cloudflare's public OpenAPI document (github.com/cloudflare/api-schemas) into the compact
// operation index the Cloudflare API resource serves from. The full document is ~28 MB with 7,000
// schemas; the index keeps per operation only what routing, scope checks, approval tiers and the
// agent's `describeOperation()` need, with request and response schemas rendered as short
// TypeScript-like text.
//
// Usage (from this package):
//   node scripts/generate-api-spec.ts                 # fetch the pinned commit
//   node scripts/generate-api-spec.ts --ref <sha>     # fetch and pin another commit
//   node scripts/generate-api-spec.ts --file <path>   # use a local openapi.json, keep the pin
//
// The output in src/api-spec/ is committed, so builds and deploys never reach the network.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "api-spec");
const SOURCE_FILE = join(OUT_DIR, "source.json");
const REPO = "cloudflare/api-schemas";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
/** Request body types sent as JSON. Everything else is listed but refused at call time. */
const JSON_TYPES = new Set([
  "application/json", "application/merge-patch+json", "application/scim+json",
]);
const MAX_SUMMARY = 200;
const MAX_DESCRIPTION = 600;
const MAX_PROP_DESCRIPTION = 120;
const MAX_SCHEMA_TEXT = 6000;
const MAX_DEPTH = 4;
const MAX_PROPS = 60;
const MAX_ENUM = 16;
const MAX_UNION = 8;

type Json = any;

function args() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { ref: get("--ref"), file: get("--file") };
}

async function loadDocument(): Promise<{ doc: Json; ref: string }> {
  const { ref: refArg, file } = args();
  const pinned = (() => {
    try { return JSON.parse(readFileSync(SOURCE_FILE, "utf8")).ref as string; } catch { return undefined; }
  })();
  if (file) return { doc: JSON.parse(readFileSync(file, "utf8")), ref: pinned ?? "local" };
  const ref = refArg ?? pinned;
  if (!ref) throw new Error("No pinned ref in src/api-spec/source.json; pass --ref <commit sha>.");
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/openapi.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return { doc: await res.json(), ref };
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

class Renderer {
  readonly doc: Json;
  constructor(doc: Json) { this.doc = doc; }

  resolve(node: Json): Json {
    let current = node;
    for (let i = 0; i < 20 && current && typeof current.$ref === "string"; i++) {
      const path = current.$ref.replace(/^#\//, "").split("/");
      current = path.reduce((acc: Json, key: string) => acc?.[key], this.doc);
    }
    return current ?? {};
  }

  refName(node: Json): string | undefined {
    return typeof node?.$ref === "string" ? node.$ref.split("/").pop() : undefined;
  }

  /** Merges allOf parts that are objects into one; returns null when a part is not an object. */
  mergeAllOf(parts: Json[], seen: Set<string>): Json | null {
    const merged: Json = { type: "object", properties: {}, required: [] };
    for (const raw of parts) {
      const name = this.refName(raw);
      if (name && seen.has(name)) continue;
      let part = this.resolve(raw);
      if (part.allOf) {
        part = this.mergeAllOf(part.allOf, name ? new Set([...seen, name]) : seen);
        if (!part) return null;
      }
      if (part.type && part.type !== "object" && !part.properties) return null;
      if (part.oneOf || part.anyOf) return null;
      Object.assign(merged.properties, part.properties ?? {});
      merged.required.push(...(part.required ?? []));
      if (part.description && !merged.description) merged.description = part.description;
    }
    return merged;
  }

  /** The `result` member of Cloudflare's response envelope, or the whole schema if there is none. */
  envelopeResult(node: Json): Json | undefined {
    let schema = this.resolve(node);
    if (schema.allOf) schema = this.mergeAllOf(schema.allOf, new Set()) ?? schema;
    const props = schema.properties;
    if (props && "success" in props && "errors" in props) {
      return props.result;
    }
    return node;
  }

  render(node: Json, mode: "request" | "response", depth = 0, seen = new Set<string>()): string {
    if (node === undefined || node === null) return "unknown";
    const name = this.refName(node);
    if (name) {
      if (seen.has(name)) return name;
      seen = new Set([...seen, name]);
    }
    const s = this.resolve(node);
    const nullable = s.nullable ? " | null" : "";
    if (s.allOf) {
      const merged = this.mergeAllOf(s.allOf, seen);
      if (merged) return this.render(merged, mode, depth, seen) + nullable;
      return s.allOf.slice(0, MAX_UNION).map((p: Json) => this.render(p, mode, depth, seen)).join(" & ");
    }
    const union = s.oneOf ?? s.anyOf;
    if (union) {
      const parts = [...new Set(union.slice(0, MAX_UNION)
        .map((p: Json) => this.render(p, mode, depth, seen)))];
      if (union.length > MAX_UNION) parts.push("…");
      return parts.join(" | ") + nullable;
    }
    if (Array.isArray(s.enum)) {
      const values = s.enum.slice(0, MAX_ENUM).map((v: unknown) => JSON.stringify(v));
      if (s.enum.length > MAX_ENUM) values.push("…");
      return values.join(" | ") + nullable;
    }
    const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
    switch (type) {
      case "string": return (s.format === "binary" ? "Blob" : "string") + nullable;
      case "integer":
      case "number": return "number" + nullable;
      case "boolean": return "boolean" + nullable;
      case "array": {
        const item = this.render(s.items, mode, depth + 1, seen);
        return (/[|&]/.test(item) ? `(${item})[]` : `${item}[]`) + nullable;
      }
    }
    if (type === "object" || s.properties || s.additionalProperties) {
      if (depth >= MAX_DEPTH) return "object" + nullable;
      const required = new Set<string>(s.required ?? []);
      const entries = Object.entries<Json>(s.properties ?? {}).filter(([, raw]) => {
        const prop = this.resolve(raw);
        return mode === "request" ? !prop.readOnly : !prop.writeOnly;
      });
      const fields = entries.slice(0, MAX_PROPS).map(([key, raw]) => {
        const prop = this.resolve(raw);
        const doc = depth <= 1 ? clip(prop.description ?? raw.description, MAX_PROP_DESCRIPTION) : undefined;
        const keyText = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
        const optional = required.has(key) ? "" : "?";
        return `${doc ? `/** ${doc.replace(/\*\//g, "* /")} */ ` : ""}${keyText}${optional}: ` +
          this.render(raw, mode, depth + 1, seen);
      });
      if (entries.length > MAX_PROPS) fields.push("…");
      if (s.additionalProperties && typeof s.additionalProperties === "object") {
        fields.push(`[key: string]: ${this.render(s.additionalProperties, mode, depth + 1, seen)}`);
      }
      return (fields.length ? `{ ${fields.join("; ")} }` : "object") + nullable;
    }
    return "unknown";
  }
}

function capped(text: string): string {
  return text.length > MAX_SCHEMA_TEXT ? text.slice(0, MAX_SCHEMA_TEXT - 1) + "…" : text;
}

async function main() {
  const { doc, ref } = await loadDocument();
  const r = new Renderer(doc);
  const operations: Json[] = [];
  const schemas: Record<string, Json> = {};
  const commandCounts = new Map<string, number>();

  for (const [path, item] of Object.entries<Json>(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const group: string | undefined = op["x-fern-sdk-group-name"];
      const verb: string | undefined = op["x-fern-sdk-method-name"];
      const command = group && verb ? `${group}.${verb}` : undefined;
      if (command) commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);

      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .map((p: Json) => r.resolve(p))
        .filter((p: Json) => p.in === "path" || p.in === "query")
        .map((p: Json) => ({
          name: p.name as string,
          in: p.in as "path" | "query",
          ...(p.required ? { required: true } : {}),
          type: r.render(p.schema, "request", 2),
          ...(clip(p.description ?? r.resolve(p.schema).description, MAX_PROP_DESCRIPTION)
            ? { description: clip(p.description ?? r.resolve(p.schema).description, MAX_PROP_DESCRIPTION) }
            : {}),
        }));

      const requestBody = op.requestBody ? r.resolve(op.requestBody) : undefined;
      const bodyTypes = Object.keys(requestBody?.content ?? {});
      const jsonType = bodyTypes.find(t => JSON_TYPES.has(t));
      const bodyType = jsonType ?? bodyTypes[0];
      const bodySchema = bodyType ? requestBody.content[bodyType].schema : undefined;

      const okKey = ["200", "201", "202", "204"].find(k => op.responses?.[k]);
      const ok = okKey ? r.resolve(op.responses[okKey]) : undefined;
      const okTypes = Object.keys(ok?.content ?? {});
      const responseJson = ok?.content?.["application/json"]?.schema;
      const responseType = responseJson ? "json" : okTypes.length === 0 ? "none"
        : okTypes.every(t => t.startsWith("text/") || t.includes("json") || t.includes("csv")
            || t.includes("pem") || t.includes("xml") || t.includes("javascript")) ? "text" : "binary";

      const pagination = op["x-fern-pagination"]
        ? "cursor"
        : params.some(p => p.name === "page") && params.some(p => p.name === "per_page") ? "page"
          : params.some(p => p.name === "cursor") ? "cursor" : undefined;

      operations.push({
        id: op.operationId,
        ...(command ? { command } : {}),
        product: (group ?? path.split("/")[1]).split(".")[0],
        method: method.toUpperCase(),
        path,
        summary: clip(op.summary, MAX_SUMMARY) ?? op.operationId,
        ...(op["x-forge-require-confirmation"]
          ? { confirm: clip(String(op["x-forge-require-confirmation"]), MAX_SUMMARY) } : {}),
        ...(op.deprecated ? { deprecated: true } : {}),
        ...(pagination ? { pagination } : {}),
        ...(bodyType ? { body: jsonType ? "json" : bodyType } : {}),
        ...(bodyType && requestBody.required ? { bodyRequired: true } : {}),
        response: responseType,
        ...(op["x-api-token-group"]?.length ? { permissions: op["x-api-token-group"] } : {}),
      });

      schemas[op.operationId] = {
        ...(clip(op.description, MAX_DESCRIPTION) ? { description: clip(op.description, MAX_DESCRIPTION) } : {}),
        params,
        ...(bodySchema ? { body: capped(r.render(bodySchema, "request")) } : {}),
        ...(responseJson ? { result: capped(r.render(r.envelopeResult(responseJson), "response")) } : {}),
      };
    }
  }

  // A command shared by several operations (e.g. the same verb at two path depths) is ambiguous;
  // those operations are addressed by operationId only.
  for (const op of operations) {
    if (op.command && commandCounts.get(op.command)! > 1) delete op.command;
  }
  operations.sort((a, b) => a.id.localeCompare(b.id));

  const products: Record<string, string> = {};
  for (const [key, value] of Object.entries<Json>(doc["x-forge-commands"] ?? {})) {
    if (value?.description) products[key] = clip(value.description, MAX_SUMMARY)!;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "operations.json"), JSON.stringify(operations) + "\n");
  // A Text module rather than JSON: it is parsed on the first `describeOperation()`, not at startup.
  writeFileSync(join(OUT_DIR, "schemas.txt"), JSON.stringify(schemas) + "\n");
  writeFileSync(join(OUT_DIR, "products.json"), JSON.stringify(products, null, 1) + "\n");
  writeFileSync(SOURCE_FILE, JSON.stringify({
    repository: `https://github.com/${REPO}`, ref, version: doc.info?.version,
    operations: operations.length,
  }, null, 2) + "\n");
  console.log(`Wrote ${operations.length} operations from ${REPO}@${ref}.`);
}

await main();
