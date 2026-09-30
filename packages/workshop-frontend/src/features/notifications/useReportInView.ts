import { useEffect } from 'react'
import type { RpcStub } from 'capnweb'
import { IN_VIEW_REPORT_TTL_MS, type Overseer } from '@gadgets/workshop-shared/api'

/** How often an in-view page repeats its report, well within the server's TTL. */
export const IN_VIEW_REPORT_INTERVAL_MS = IN_VIEW_REPORT_TTL_MS / 3

/**
 * Tells the workspace whether this page is in view, so the owner gets no push notifications about
 * a workspace they are looking at, and does get them once they switch away. Reports on every
 * visibility change and repeats while visible: iOS can suspend a backgrounded app before its
 * "hidden" report goes out, and the server then lets the last report lapse.
 */
export const useReportInView = (overseer: RpcStub<Overseer> | null) => {
  useEffect(() => {
    if (!overseer) return
    const report = () => {
      overseer.reportInView(document.visibilityState === 'visible').catch(() => {})
    }
    report()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') report()
    }, IN_VIEW_REPORT_INTERVAL_MS)
    document.addEventListener('visibilitychange', report)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', report)
      overseer.reportInView(false).catch(() => {})
    }
  }, [overseer])
}
