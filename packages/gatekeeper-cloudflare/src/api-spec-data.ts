// The bundled operation catalog. Kept apart from `api-spec.ts` so only Worker code pulls in the
// generated data: the index is ~1.2 MB of JSON, and the per-operation detail (~6 MB) ships as a
// Text module that is parsed on first use rather than at isolate startup.

import { ApiCatalog, type ApiOperation, type ApiOperationSchema } from "./api-spec.js";
import OPERATIONS from "./api-spec/operations.json";
import PRODUCTS from "./api-spec/products.json";
import SCHEMAS_TEXT from "./api-spec/schemas.txt";

let catalog: ApiCatalog | undefined;

/** The process-wide catalog, built on first use. */
export function apiCatalog(): ApiCatalog {
  catalog ??= new ApiCatalog(
    OPERATIONS as ApiOperation[],
    () => JSON.parse(SCHEMAS_TEXT) as Record<string, ApiOperationSchema>,
  );
  return catalog;
}

/** One-line descriptions of the top-level products, keyed by product name. */
export const API_PRODUCTS: Readonly<Record<string, string>> = PRODUCTS;
