# Gatekeeper Cloudflare

This package provides Cloudflare OAuth integration for Gadgets. It serves four purposes:

- **Sign-in:** when `cloudflare` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  Cloudflare" appears on the login page. The grant reads the account email (verified by Cloudflare,
  via the `/user` API), which becomes the user's identity. Cloudflare sign-in also establishes the
  persistent billing-only connection described below.
- **AI Gateway billing:** when a user connects Cloudflare or signs in with it, the billing scopes are
  requested and the connection persists. The Workshop then reads a usable access
  token from it (`getUsableAccessToken`) to power the [AI Gateway billing](../../docs/ai-gateway-billing.md)
  flow — reading the credit balance and routing BYOK inference through the account's default AI
  Gateway.
- **Workers Observability:** gadgets can receive read-only access to logs, events, invocations,
  aggregate metrics, and traces either across an account or restricted to one Worker. Every result
  is authorized as an observation, and Worker bindings inject an immutable service filter and
  defensively discard foreign-service events. Distributed trace summaries are account-only because
  their names, timing, services, and counts describe the whole cross-service trace; a Worker binding
  can still retrieve its own events for a known trace ID.
- **Cloudflare API (opt-in):** gadgets can read and change an account's or a zone's configuration
  through the whole Cloudflare REST API, the same surface the `cf` CLI covers. Reads are observations;
  every change waits for approval. See [Cloudflare API resource](#cloudflare-api-resource).

Observability connections request `workers-observability.read`. The OAuth client must allow that
scope or Cloudflare will omit/reject it. Existing billing-only connections can add the grant when the
user first selects an observability resource. Cloudflare exposes account and Worker resource choices,
but both map to this one indivisible OAuth scope; resource bindings provide the finer capability
boundary after connection.

Workers telemetry is retained by Cloudflare for at most seven days. Queries default to the last hour,
and the Worker picker searches the full retention window. Suggested bindings are
`CLOUDFLARE_OBSERVABILITY` for account access and `WORKER_OBSERVABILITY` for one Worker.

### Sharing a gadget that reads telemetry

A binding is not transferable. When a gadget with an observability binding is shared, each
collaborator is admitted only if **their own** connected Cloudflare account can read that resource
(`addObserver` checks it against their credentials, not the owner's). A collaborator without access is
refused, and a verification that fails for any other reason — a 5xx, a transport error — is also a
refusal rather than an admission.

### What a Worker binding trusts, and what it re-checks

The scope filter is prepended to every query, but a filter the provider *accepted* is not evidence it
*applied* it — three separate behaviours here return wrong-but-plausible data with no error. So events
are re-filtered on the way out, and a single foreign event is treated as proof the filter was dropped:
the provider's `count` is withheld (it would be a count of the whole account's matching telemetry) and
the event is logged at `error`. `statistics` is kept, because it describes what our query cost rather
than how much matched, and callers are told to read it for cost.

The re-check is deliberately not a hard failure. The events returned are filtered and therefore safe,
and this provider has surprised us often enough that turning a hypothetical disclosure into a
guaranteed outage would be the worse trade.

`calculate()` is the exception, and knowingly so: an aggregate cannot be un-mixed, so there is no
second line of defence to add. It rests entirely on the injected filter. The fix that would work —
grouping by `$metadata.service` and keeping this binding's own group, whose value *is* the correctly
scoped answer even for a median — changes `limit` and `orderBy` semantics for every caller, so it is a
follow-up rather than a footnote.

### Why discovery sometimes costs a query

Cloudflare's `telemetry/keys` and `telemetry/values` endpoints ignore the `filters` array they accept:
verified against a live account, they answer for the whole account no matter what is passed. A
Worker-scoped binding therefore cannot use them — they would disclose every field name and value in
the account. Whenever a discovery call has to be constrained (a Worker binding, or any caller-supplied
filter), the answer is derived instead from a filtered `telemetry/query` events sample, which the
provider does filter correctly. Unconstrained account-wide discovery still uses the cheap endpoints.

> Unresolved: whether the `workers-observability.read` scope alone is accepted, or whether Cloudflare
> requires the Workers Observability **Write** permission to read telemetry. This has not been
> verified against a live token; if reads 403 on a correctly-scoped grant, that is the first thing to
> check.

### Two names for one field

A log's own structured fields are returned nested under `source` but are **indexed under their bare
name**: `logger.warn(msg, {event: "x"})` comes back as `source.event` and is queried as `event`.
Confirmed both ways — `telemetry/keys` on a live account reports `event`/`component`/`level` and no
`source.*` key at all, and the [Workers Logs
docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) show
`console.log({user_id: 123})` being filtered as `user_id`.

This matters because the provider accepts an unknown filter key, matches nothing, and returns an empty
page with no error. So discovery reports indexed names (`observability-discovery.ts`), and
`observabilityFieldKey` additionally accepts a `source.`-prefixed key as an alias wherever a caller
names a field — filters, `calculations`, `groupBys`, `listValues` — because copying a path out of a
`listEvents` result is the obvious thing to do and used to fail silently.

`openid` is intentionally **not** requested — the Cloudflare dashboard OAuth client isn't permitted
that scope; identity comes from the `/user` API (`user-details.read`).

### Why an error's text never reaches the log

`summarizeFilter` deliberately keeps filter *values* out of the audit trail — they are caller text.
But a provider error message can quote that same value straight back, so logging the message would
readmit through the error path exactly what the audit path excludes. `CloudflareObservabilityApiError`
therefore carries Cloudflare's numeric `codes` alongside the message: the request log names the
codes, and the message travels only to the caller who caused it.

The codes are not the discriminator, though — Cloudflare can return a message with no numeric code
at all, so the error records separately whether the message is *its* or *ours*, and only ours is
logged. A provider failure carrying no codes is therefore logged as a bare status, which is the
fail-closed answer: the status still says what happened without quoting anyone's filter back.

### Listing accounts is a walk, not a request

`/accounts` is paginated and defaults to **20** per page, so a single GET silently returns a truncated
list — an account past the first page simply cannot be picked, with nothing to indicate why. The
account picker's substring match also stays client-side: `name` is the only documented server-side
filter and whether it matches exactly or by substring is not specified, so pushing it down would trade
a visible truncation for an invisible one.

## Cloudflare API resource

Off by default. Set `ENABLE_API_RESOURCE=true` on the gatekeeper Worker to offer it, and make sure the
deployment's OAuth client allows every scope in `API_SCOPES` (`src/resources.ts`): Cloudflare refuses
an authorization that asks for a scope the client may not request. The flag also decides whether a
"connect all resources" flow asks for those scopes, so existing deployments are unaffected until it is
set.

### Bindings

| Binding | Resource URL | Reaches |
|---|---|---|
| Account | `https://dash.cloudflare.com/<accountId>` | `/accounts/<accountId>/…`, `/zones/<id>/…` for zones that account owns, `/zones` (pinned to the account), Radar and `/ips` |
| Zone | `https://dash.cloudflare.com/<accountId>/<zone name>` | `/zones/<that zone id>/…`, Radar and `/ips` |
| Narrowed (either) | `…#products=dns,rulesets&access=read` | Only the listed products; `access=read` refuses every change |

`/user`, `/memberships`, `/accounts` (the list), organizations and every other path outside an account
are refused. An unknown fragment key is an error, not ignored, so a newer configurator's narrowing
can never be silently dropped. Suggested binding names are `CLOUDFLARE_API` and `CLOUDFLARE_ZONE_API`;
the session type is `CloudflareApiSession` (`src/api-types.d.ts`).

### The operation catalog

`src/api-spec/` is compiled from Cloudflare's public OpenAPI document
([cloudflare/api-schemas](https://github.com/cloudflare/api-schemas)) by
`scripts/generate-api-spec.ts`, pinned to the commit in `src/api-spec/source.json`, and committed so
builds never reach the network. Refresh it with `pnpm api-spec:update` (or `--ref <sha>` to move the
pin). `operations.json` (~1.2 MB) is the index; `schemas.txt` (~6 MB) holds parameters and
TypeScript-like body and result shapes, and is parsed on the first `describeOperation()`.

Every request resolves to a catalog operation before anything else happens, by `id`, by its `cf`-style
command (`dns.records.create`), or by method and concrete path. A request that resolves to none is
refused: nothing is forwarded to `api.cloudflare.com` that the catalog does not describe. Only JSON
request bodies are sent; uploads (multipart, octet-stream) and binary responses are refused for now.

### Tiers

`src/api-tiers.ts` classifies each operation; the rules are few and fail closed.

| Tier | Rule | Approval |
|---|---|---|
| `read` | GET, plus a reviewed list of query POSTs (`logs.query`, `analytics-engine.sql.query`, …) | Observation |
| `write` | Any other change | Approval; auto-approvable per product (`cloudflare.api.<product>`) |
| `destructive` | DELETE, or Cloudflare's CLI asks to confirm (`x-forge-require-confirmation`) | Always a person; Cloudflare's warning is shown |
| `privileged` | Members, roles, API tokens, IdPs, service tokens, OAuth clients, billing, registrar | Always a person |
| `blocked` | Returns a live credential (tunnel run token, temporary R2 keys, Pages upload token) | Refused |

`d1.query` is deliberately not a read: its SQL may write. `__tests__/api-catalog.test.ts` fails when
a spec refresh renames a command one of the lists names.

### How a change runs

1. `prepare()` checks the operation against the binding (product, tier, path scope), fills
   `account_id` (and `zone_id` on a zone binding), and confirms a `zone_id` belongs to the bound
   account by reading the zone from Cloudflare (cached for five minutes). `POST /zones` must name
   the bound account in its body.
2. For PUT, PATCH and DELETE on a resource with a GET on the same path, the current state is read and
   its SHA-256 digest stored; the approval shows it next to the request body.
3. The approval shows the full URL, every path parameter, the query and the request body verbatim.
   Nothing is simulated, so `awaitDecision` is set.
4. On approval, `applyAction()` runs step 1 again (a zone can change accounts while a change waits),
   re-reads the resource and refuses if its digest moved, then sends the stored body text unchanged.
   The claim is persisted before sending: a 4xx is recorded as retryable, anything else as an
   unknown outcome that is never replayed.
5. `getActionResult()` returns the redacted response and records it as an observation.

### Credentials in responses

`src/api-redact.ts` replaces `client_secret`, `secret`, `token`, `password`, `private_key` and similar
fields anywhere in a response, and `value` for API-token operations, before the caller or an approval
sees them. Operations whose whole answer is a credential are blocked rather than redacted.

### Sharing

API bindings use observer strategy A: a gadget holding one can only be opened by the person who
connected it. A member's Cloudflare role may cover fewer products than the binding, and there is no one
check that proves a collaborator could read everything the binding has read.

### Not yet

- GraphQL Analytics (its queries name accounts and zones in the query text, which needs parsing to
  scope).
- Uploads and binary downloads.
- Account-owned API tokens as an alternative to OAuth.

## Setting Up Cloudflare OAuth Credentials

You need a Cloudflare dashboard OAuth client (client id + secret). The dashboard OAuth endpoints and
scopes are hardcoded in `src/oauth.ts`, so you only configure the client id/secret and register the
redirect URI. Ensure the client's scope allowlist includes `workers-observability.read` when this
deployment offers Workers Observability resources.

### Step 1: Register the redirect URI

The gatekeeper's OAuth redirect URI is:

```
${BASE_URL}/oauth
```

where `BASE_URL` defaults to `http://localhost:8787/gatekeeper/cloudflare` in dev — i.e. the full
redirect URI is:

```
http://localhost:8787/gatekeeper/cloudflare/oauth
```

Register **exactly** this (replace the host with your `PUBLIC_BASE_URL` when not running locally) as
an allowed/pre-registered redirect URL on the Cloudflare OAuth client. If it isn't registered you'll
get an `invalid_request` error: _"the 'redirect_uri' parameter does not match any of the OAuth 2.0
Client's pre-registered redirect urls."_

### Step 2: Configure Your Local Environment

Create a `.env` file in this package's directory (`packages/gatekeeper-cloudflare/.env`):

```bash
CLIENT_ID=your-client-id-here
CLIENT_SECRET=your-client-secret-here
```

In local dev, `run-dev-server.ts` will also seed these from `CLOUDFLARE_OAUTH_CLIENT_ID` /
`CLOUDFLARE_OAUTH_CLIENT_SECRET` if you'd rather set them in the root `.dev.vars`. A per-package
`.env` takes precedence and keeps the credential with the gatekeeper that uses it.

> **Note**: The `.env` file is gitignored and should never be committed.

### Step 3: (Optional) Enable Cloudflare sign-in / billing

To offer "Continue with Cloudflare" on the login page, add `cloudflare` to the deployment's
`AUTH_GATEKEEPERS` allowlist (e.g. in the root `.dev.vars`):

```
AUTH_GATEKEEPERS=cloudflare,google,github
```

The order controls the order of the login buttons. For the AI Gateway billing / top-up flow, also
set `ENABLE_CLOUDFLARE_LIMITS=true` (see [AI Gateway billing](../../docs/ai-gateway-billing.md)); a
user enables billing by connecting Cloudflare, which requests the billing scopes
(`offline_access aig.read aig.run user-details.read account-settings.read`). Connecting all
Cloudflare gadget resources also requests `workers-observability.read`.

### Step 4: Verify Setup

1. Start the application in dev mode (see the root README.md).
2. On the login page, click **Continue with Cloudflare**.
3. A pop-up opens to the Cloudflare authorization page; approve it.
4. The pop-up closes and you're signed in, identified by your Cloudflare account email.
5. To use AI Gateway credits, open **Usage & billing** in settings and **Connect Cloudflare** (this
   requests billing scopes only).

## Troubleshooting

### "redirect_uri ... does not match any of the ... pre-registered redirect urls"

The redirect URI isn't registered on the OAuth client. Register exactly
`http://localhost:8787/gatekeeper/cloudflare/oauth` (or your `PUBLIC_BASE_URL` equivalent) — no
trailing slash, `http` not `https` for localhost.

### "Not configured" page during authorization

`CLIENT_ID` / `CLIENT_SECRET` are missing. Ensure they're set (per-package `.env` or seeded from the
root `.dev.vars`), then restart the dev server.
