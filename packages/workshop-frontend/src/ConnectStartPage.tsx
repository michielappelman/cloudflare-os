import { useEffect, useState } from 'react'
import { HANDOFF_KEY, readPopupStart } from './connectHandoff'

/**
 * The page a connect / sign-in popup starts on (START_PATH) when the Workshop tab could not hand it
 * the flow's nonce directly: the browser opened the popup but gave the tab no handle on it, or no
 * access to its storage (see `openDisownedPopup`). The handoff and the flow's URL arrive in the
 * fragment; this page stores the handoff in its own sessionStorage, where ConnectHandoffPage reads
 * it at the end of the flow, drops `window.opener` so no page in the flow gets a handle on the tab,
 * and navigates on.
 */
export default function ConnectStartPage() {
  // Read once, before the fragment is stripped below.
  const [start] = useState(() => readPopupStart(window.location.hash))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname)
    if (start === null) {
      setError('Start the connection again from the Workshop.')
      return
    }
    try {
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(start.handoff))
    } catch {
      setError('This browser blocks storage in pop-ups, so the flow cannot complete. Allow site data for this site and try again.')
      return
    }
    window.opener = null
    window.location.replace(start.url)
  }, [start])

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 bg-kumo-base p-6 text-center">
      <h1 className="text-lg font-semibold text-kumo-default">
        {error ? "This link isn't valid" : 'Opening…'}
      </h1>
      {error && <p className="text-sm text-kumo-subtle">{error}</p>}
    </div>
  )
}
