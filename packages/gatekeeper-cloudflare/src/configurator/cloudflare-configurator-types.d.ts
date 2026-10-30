import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";

export type CloudflareAccountConfiguratorValues = {
  accountId?: string | null;
};

export type CloudflareWorkerConfiguratorValues = {
  accountId?: string | null;
  workerName?: string | null;
};

export interface CloudflareAccountConfiguratorRpc {
  listAccounts(query: string): Promise<ConfiguratorUIOption[]>;
}

export interface CloudflareWorkerConfiguratorRpc extends CloudflareAccountConfiguratorRpc {
  listWorkers(accountId: string, query: string): Promise<ConfiguratorUIOption[]>;
}

export type CloudflareApiConfiguratorValues = {
  accountId?: string | null;
  /** `"account"` for the whole account, `"zone"` for one zone. */
  scope?: string | null;
  zoneName?: string | null;
  /** `"all"` or `"choose"`. */
  productMode?: string | null;
  /** Comma-separated product names when `productMode` is `"choose"`. */
  products?: string | null;
  /** `"change"` or `"read"`. */
  access?: string | null;
};

export interface CloudflareApiConfiguratorRpc extends CloudflareAccountConfiguratorRpc {
  listZones(accountId: string, query: string): Promise<ConfiguratorUIOption[]>;
  listProducts(): Promise<ConfiguratorUIOption[]>;
}
