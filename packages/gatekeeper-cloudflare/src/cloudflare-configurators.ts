import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { listAccounts, listZones } from "./cloudflare-api.js";
import { apiCatalog, API_PRODUCTS } from "./api-spec-data.js";
import { CloudflareObservabilityApi } from "./observability-api.js";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import type {
  CloudflareAccountConfiguratorRpc,
  CloudflareApiConfiguratorRpc,
  CloudflareWorkerConfiguratorRpc,
} from "./configurator/cloudflare-configurator-types.js";

const OPTION_LIMIT = 100;
const DISCOVERY_LIMIT = 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const tokenGetters = new WeakMap<object, () => Promise<string | null>>();

function tokenFor(target: object): Promise<string | null> {
  const getToken = tokenGetters.get(target);
  if (!getToken) throw new Error("Cloudflare configurator is not initialized.");
  return getToken();
}

@validateRpc()
export class CloudflareAccountConfiguratorUI extends RpcTarget
    implements CloudflareAccountConfiguratorRpc {
  constructor(getToken: () => Promise<string | null>) {
    super();
    tokenGetters.set(this, getToken);
  }

  async listAccounts(query: string): Promise<ConfiguratorUIOption[]> {
    const token = await tokenFor(this);
    if (!token) return [];
    const needle = query.trim().toLowerCase();
    return (await listAccounts(token))
      .filter(account => !needle || account.accountName.toLowerCase().includes(needle))
      .slice(0, OPTION_LIMIT)
      .map(account => ({ value: account.accountId, title: account.accountName }));
  }
}

@validateRpc()
export class CloudflareWorkerConfiguratorUI extends CloudflareAccountConfiguratorUI
    implements CloudflareWorkerConfiguratorRpc {
  async listWorkers(accountId: string, query: string): Promise<ConfiguratorUIOption[]> {
    const to = new Date();
    const values = await new CloudflareObservabilityApi(
      () => tokenFor(this), accountId,
    ).listValues("$metadata.service", "string", {
      timeframe: { from: new Date(to.valueOf() - RETENTION_MS), to },
      limit: DISCOVERY_LIMIT,
    });
    const needle = query.trim().toLowerCase();
    return values
      .filter((value): value is typeof value & { value: string } =>
        typeof value.value === "string" && (!needle || value.value.toLowerCase().includes(needle)))
      .slice(0, OPTION_LIMIT)
      .map(value => ({ value: value.value, title: value.value }));
  }
}

@validateRpc()
export class CloudflareApiConfiguratorUI extends CloudflareAccountConfiguratorUI
    implements CloudflareApiConfiguratorRpc {
  async listZones(accountId: string, query: string): Promise<ConfiguratorUIOption[]> {
    const token = await tokenFor(this);
    if (!token) return [];
    return (await listZones(token, accountId, query)).map(zone => ({
      value: zone.zoneName, title: zone.zoneName, meta: zone.status,
    }));
  }

  async listProducts(): Promise<ConfiguratorUIOption[]> {
    const counts = new Map<string, number>();
    for (const operation of apiCatalog().all()) {
      counts.set(operation.product, (counts.get(operation.product) ?? 0) + 1);
    }
    return [...counts].toSorted(([a], [b]) => a.localeCompare(b)).map(([product, count]) => ({
      value: product,
      title: product,
      ...(API_PRODUCTS[product] ? { subtitle: API_PRODUCTS[product] } : {}),
      meta: `${count} operations`,
    }));
  }
}
