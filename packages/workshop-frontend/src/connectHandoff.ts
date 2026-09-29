// The browser half of the gatekeeper connect handoff (see `GatekeeperVendor.connectAccount` in
// workshop-shared). A connect URL is a bearer capability, so the Workshop opens it as a disowned
// popup carrying the flow's nonce in the popup's own sessionStorage. When the flow finishes, the
// gatekeeper's final page navigates that popup to HANDOFF_PATH on this origin with the single-use
// ticket in the URL fragment, and ConnectHandoffPage redeems ticket and nonce together over the
// popup's own session. Redeeming is what activates the grant.

import type { ConnectFlowStart } from '@gadgets/workshop-shared/api'

/** Host the backend (and, through the router, every gatekeeper) is served from. */
export function getBackendHost(): string {
  // Only the Vite dev server is hosted separately from the backend. Built assets are served from
  // the same origin in both production and run-local mode.
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  }
  return window.location.host
}

/**
 * Path on the Workshop origin a finished connect / sign-in popup lands on, with the ticket in the
 * URL fragment. gatekeeper-kit duplicates the literal, since it must not depend on this package;
 * each package pins it with a test.
 */
export const HANDOFF_PATH = '/connect/handoff'

/**
 * Path on the Workshop origin that starts a flow in a popup this tab could not hand the nonce to
 * directly (see `openDisownedPopup`), with the handoff and the flow's URL in the URL fragment.
 */
export const START_PATH = '/connect/start'

const HEX_256_PATTERN = /^[0-9a-f]{64}$/

/**
 * The ticket a handoff URL fragment carries (`window.location.hash`, with or without its leading
 * '#', percent-encoded or not), or null unless it decodes to 64 lowercase hex characters.
 */
export function ticketFromHandoffFragment(hash: string): string | null {
  const encoded = hash.startsWith('#') ? hash.slice(1) : hash
  let ticket: string
  try {
    ticket = decodeURIComponent(encoded)
  } catch {
    return null
  }
  return HEX_256_PATTERN.test(ticket) ? ticket : null
}

/** sessionStorage key under which the Workshop writes a `PopupHandoff` into a popup it opened. */
export const HANDOFF_KEY = 'gadgets.handoff'

/**
 * The record the Workshop tab writes into a popup's own sessionStorage before navigating it: which
 * kind of flow the popup runs, and the flow's nonce, which the handoff page presents with the
 * ticket (`completeConnectHandoff` for a connect, `confirmLogin` for a sign-in).
 */
export type PopupHandoff = { kind: 'connect' | 'login'; nonce: string }

/**
 * Opens `url` as a popup that holds `handoff` and nothing else of this tab. The popup is opened
 * empty (a same-origin about:blank, so its sessionStorage is ours to write), disowned, given the
 * nonce, and only then navigated, so no page in the flow ever holds `window.opener`: a connect flow
 * can land on pages the deployment does not vouch for (an MCP server the user pasted, say), and an
 * opener handle would let such a page navigate this authenticated tab to a phishing page (reverse
 * tabnabbing). With no opener in play the flow is also indifferent to a provider isolating its
 * pages with COOP.
 *
 * The nonce goes into the popup's storage, not this tab's: it then exists only on the server and
 * in that popup, nothing opened from this tab inherits it, and a handoff link opened any other way
 * (a fresh tab, a pasted URL, a link an attacker sends) holds none and redeems nothing.
 *
 * Disowning is done by hand rather than with the `noopener` feature, which makes `window.open()`
 * return null even on success, indistinguishable from a pop-up block. `name` must be fresh per
 * flow: `window.open('', existingName)` returns an existing window without navigating it, and one
 * parked on a provider page is cross-origin, so the storage write would throw.
 *
 * Some browsers (Orion, for one) open the popup but return null, which is indistinguishable from a
 * block, or return a window whose storage this tab may not write. Either way the popup is then sent,
 * by name, to START_PATH with the handoff and `url` in the fragment (never sent to a server), and
 * that same-origin page stores the nonce, disowns itself and navigates on (see `readPopupStart`).
 * Returns null in that case, since there is no handle to return. If the browser really did block
 * the popup, the second open is blocked too and nothing happens.
 */
export function openDisownedPopup(url: string, name: string, handoff: PopupHandoff): Window | null {
  const popup = window.open('', name, POPUP_FEATURES)
  if (popup) {
    try {
      popup.opener = null
      popup.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff))
      popup.location.replace(url)
      return popup
    } catch {
      // Fall through to the start page, which writes the storage from inside the popup.
    }
  }
  const startUrl = `${START_PATH}#${encodeURIComponent(JSON.stringify({ ...handoff, url }))}`
  if (popup) {
    popup.location.replace(startUrl)
    return popup
  }
  window.open(startUrl, name, POPUP_FEATURES)
  return null
}

const POPUP_FEATURES = 'popup,width=520,height=680'

/** What START_PATH's fragment carries: the handoff to store, and the flow's URL to navigate to. */
export type PopupStart = { handoff: PopupHandoff; url: string }

/**
 * The `PopupStart` in a START_PATH fragment (`window.location.hash`), or null unless it names a
 * well-formed handoff and a URL under `/gatekeeper/` on the Workshop's backend origin, where every
 * connect and sign-in flow starts. Anything else is refused, so the page can't be used to send a
 * visitor to an arbitrary site.
 */
export function readPopupStart(hash: string): PopupStart | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(hash.startsWith('#') ? hash.slice(1) : hash))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { kind, nonce, url } = parsed as { kind?: unknown; nonce?: unknown; url?: unknown }
  if (kind !== 'connect' && kind !== 'login') return null
  if (typeof nonce !== 'string' || !HEX_256_PATTERN.test(nonce)) return null
  if (typeof url !== 'string') return null
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  const backendOrigin = `${window.location.protocol}//${getBackendHost()}`
  if (target.origin !== backendOrigin || !target.pathname.startsWith('/gatekeeper/')) return null
  return { handoff: { kind, nonce }, url: target.href }
}

/**
 * A window name no popup this origin still has open can share: `<prefix>-<uuid>`. A per-document
 * counter would restart on reload while an earlier disowned popup, still parked on a provider
 * page, keeps its name, and `window.open('', thatName)` would hand that cross-origin window back.
 */
export function uniquePopupName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

// The connect popup this document opened last, closed before the next one opens: a stale popup
// still parked on a provider page is otherwise left behind the new one.
let lastConnectPopup: Window | null = null

/**
 * Opens a connect / reconnect / ensure-resources flow as a disowned popup carrying the flow's
 * nonce (see `openDisownedPopup`). The popup redeems the ticket itself on ConnectHandoffPage; the
 * account arrives in this tab through `subscribeConnectedAccounts()`. Returns null when the browser
 * gave no handle on the popup.
 */
export function openConnectWindow(flow: ConnectFlowStart): Window | null {
  if (lastConnectPopup) {
    try { lastConnectPopup.close() } catch { /* cross-origin or already gone */ }
  }
  const popup = openDisownedPopup(
    flow.url, uniquePopupName('gadgets-connect'), { kind: 'connect', nonce: flow.nonce })
  lastConnectPopup = popup
  return popup
}

/**
 * The `PopupHandoff` the Workshop tab wrote into this document's sessionStorage, removed as it is
 * read (single-use on the client as well as the server), or null when there is none, it is
 * malformed, or storage is unavailable.
 */
export function readPopupHandoff(): PopupHandoff | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(HANDOFF_KEY)
    sessionStorage.removeItem(HANDOFF_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { kind, nonce } = parsed as { kind?: unknown; nonce?: unknown }
  if (kind !== 'connect' && kind !== 'login') return null
  if (typeof nonce !== 'string' || !HEX_256_PATTERN.test(nonce)) return null
  return { kind, nonce }
}
