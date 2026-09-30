// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { IN_VIEW_REPORT_INTERVAL_MS, useReportInView } from './useReportInView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let visibility: DocumentVisibilityState = 'visible'

const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

const Reporter = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  useReportInView(overseer)
  return null
}

describe('useReportInView', () => {
  let root: Root | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    vi.useRealTimers()
  })

  it('reports in view, repeats while visible, and reports hidden on switching away and unmounting', async () => {
    const reportInView = vi.fn<(inView: boolean) => Promise<void>>(async () => {})
    const overseer = { reportInView } as unknown as RpcStub<Overseer>
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(<Reporter overseer={overseer} />))
    expect(reportInView.mock.calls).toEqual([[true]])

    await act(async () => vi.advanceTimersByTime(IN_VIEW_REPORT_INTERVAL_MS))
    expect(reportInView.mock.calls).toEqual([[true], [true]])

    await act(async () => setVisibility('hidden'))
    expect(reportInView).toHaveBeenLastCalledWith(false)

    // Nothing repeats while hidden, so the server's record lapses even if "hidden" was lost.
    const callsWhileHidden = reportInView.mock.calls.length
    await act(async () => vi.advanceTimersByTime(IN_VIEW_REPORT_INTERVAL_MS * 3))
    expect(reportInView.mock.calls).toHaveLength(callsWhileHidden)

    await act(async () => setVisibility('visible'))
    expect(reportInView).toHaveBeenLastCalledWith(true)

    await act(async () => root!.unmount())
    root = undefined
    expect(reportInView).toHaveBeenLastCalledWith(false)
  })
})
