// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import ConnectStartPage from './ConnectStartPage'
import { getBackendHost, HANDOFF_KEY, START_PATH } from './connectHandoff'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NONCE = 'b'.repeat(64)

describe('ConnectStartPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  function renderAt(hash: string) {
    window.history.replaceState(null, '', `${START_PATH}${hash}`)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<ConnectStartPage />))
  }

  it('stores the handoff in this popup and strips it from the URL', () => {
    const url = `${window.location.protocol}//${getBackendHost()}/gatekeeper/kagi/x`
    renderAt(`#${encodeURIComponent(JSON.stringify({ kind: 'connect', nonce: NONCE, url }))}`)

    expect(JSON.parse(sessionStorage.getItem(HANDOFF_KEY)!)).toEqual({ kind: 'connect', nonce: NONCE })
    expect(window.location.hash).toBe('')
  })

  it('refuses a flow URL off the backend origin, storing nothing', () => {
    renderAt(`#${encodeURIComponent(JSON.stringify({
      kind: 'connect', nonce: NONCE, url: 'https://evil.example/gatekeeper/x',
    }))}`)

    expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull()
    expect(container!.textContent).toContain("This link isn't valid")
    expect(window.location.hash).toBe('')
  })
})
