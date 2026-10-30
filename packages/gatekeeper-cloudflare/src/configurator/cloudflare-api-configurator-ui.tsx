import {
  Autocomplete, CheckboxList, Field, h, RadioCards, Section, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  CloudflareApiConfiguratorRpc,
  CloudflareApiConfiguratorValues,
} from "./cloudflare-configurator-types";

// Copies of the URL grammar in `src/api-scope.ts`; `__tests__/configurator-url.test.ts` keeps them
// in step.
const ORIGIN = "https://dash.cloudflare.com";
const ZONE_PATTERN = `${ORIGIN}/:accountId/:zoneName`;

function selectedProducts(values: CloudflareApiConfiguratorValues): string[] {
  return [...new Set((values.products ?? "").split(",").map(p => p.trim()).filter(Boolean))].toSorted();
}

export default {
  initial: {
    accountId: null, scope: "account", zoneName: null, productMode: "all", products: null,
    access: "change",
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const [accountId, zoneName] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(url.hash.slice(1));
    const products = params.get("products");
    return {
      accountId: accountId ?? null,
      scope: zoneName ? "zone" : "account",
      zoneName: zoneName ?? null,
      productMode: products ? "choose" : "all",
      products: products ?? null,
      access: params.get("access") === "read" ? "read" : "change",
    };
  },

  isReady({ values, acceptedResourceUrlPatterns }) {
    if (!values.accountId) return false;
    if (values.scope === "zone") {
      if (!values.zoneName) return false;
      if (acceptedResourceUrlPatterns && !acceptedResourceUrlPatterns.includes(ZONE_PATTERN)) return false;
    }
    return values.productMode !== "choose" || selectedProducts(values).length > 0;
  },

  resourceUrl({ values }) {
    let url = `${ORIGIN}/${encodeURIComponent(values.accountId!.toLowerCase())}`;
    if (values.scope === "zone") url += `/${encodeURIComponent(values.zoneName!.toLowerCase())}`;
    const fragment: string[] = [];
    if (values.productMode === "choose") fragment.push(`products=${selectedProducts(values).join(",")}`);
    if (values.access === "read") fragment.push("access=read");
    return fragment.length > 0 ? `${url}#${fragment.join("&")}` : url;
  },

  render({ values, setValues, clearFields, ui, acceptedResourceUrlPatterns }) {
    const zoneAllowed = !acceptedResourceUrlPatterns || acceptedResourceUrlPatterns.includes(ZONE_PATTERN);
    const choosing = values.productMode === "choose";
    return <Section>
      <Field label="Cloudflare account">
        <Autocomplete
          name="accountId"
          value={values.accountId}
          placeholder="Choose an account"
          loadOptions={query => ui.listAccounts(query)}
          onChange={accountId => {
            // `clearFields` only drops the zone autocomplete's typed query; the value must be nulled
            // too or the previous account's zone survives into the URL.
            clearFields("zoneName");
            setValues({ accountId, zoneName: null });
          }}
        />
      </Field>
      <Field label="Reach">
        <RadioCards
          value={values.scope === "zone" ? "zone" : "account"}
          options={[
            { value: "account", title: "Whole account",
              description: "Every zone and account-level product, such as Workers and Zero Trust." },
            ...(zoneAllowed ? [{ value: "zone", title: "One zone",
              description: "Only one zone's settings, DNS, rules and analytics." }] : []),
          ]}
          onChange={scope => setValues({ scope, ...(scope === "account" ? { zoneName: null } : {}) })}
        />
      </Field>
      {values.scope === "zone"
        ? <Field label="Zone">
            <Autocomplete
              name="zoneName"
              value={values.zoneName}
              placeholder={values.accountId ? "Choose a zone" : "Choose an account first"}
              loadOptions={query => values.accountId ? ui.listZones(values.accountId, query) : Promise.resolve([])}
              onChange={zoneName => setValues({ zoneName })}
              disabled={!values.accountId}
            />
          </Field>
        : null}
      <Field label="Access">
        <RadioCards
          value={values.access === "read" ? "read" : "change"}
          options={[
            { value: "change", title: "Read and change",
              description: "Reads return data straight away; every change waits for your approval." },
            { value: "read", title: "Read only", description: "Changes are refused." },
          ]}
          onChange={access => setValues({ access })}
        />
      </Field>
      <Field label="Products" description={choosing
        ? `${selectedProducts(values).length} selected. Operations of other products are refused.`
        : "Every product the connection's permissions allow."}>
        <RadioCards
          compact
          value={choosing ? "choose" : "all"}
          options={[
            { value: "all", title: "All products", description: "Including products added later." },
            { value: "choose", title: "Choose products", description: "Only the products you tick." },
          ]}
          onChange={productMode => setValues({ productMode })}
        />
      </Field>
      <Field label="Allowed products">
        <CheckboxList
          name="products"
          value={values.products}
          loadOptions={() => ui.listProducts()}
          allSelected={!choosing}
          disabled={!choosing}
          onChange={products => setValues({ products })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CloudflareApiConfiguratorRpc, CloudflareApiConfiguratorValues>;
