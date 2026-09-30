// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PushSubscriptionInfo } from '@gadgets/workshop-shared/api'
import { NotificationsSetting } from './NotificationsSetting'
import { applicationServerKey } from './pushSupport'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
const SUBSCRIPTION_JSON = { endpoint: 'https://web.push.apple.com/device', keys: { p256dh: 'P', auth: 'A' } }

// A browser with the Push API: one service worker registration and a permission the test sets.
function installBrowser(options: { permission: NotificationPermission; subscribed: boolean }) {
  const subscription = {
    endpoint: SUBSCRIPTION_JSON.endpoint,
    options: { applicationServerKey: applicationServerKey(KEY).buffer },
    toJSON: () => SUBSCRIPTION_JSON,
    unsubscribe: vi.fn<() => Promise<boolean>>(async () => true),
  }
  let current = options.subscribed ? subscription : null
  const pushManager = {
    getSubscription: vi.fn<() => Promise<typeof subscription | null>>(async () => current),
    subscribe: vi.fn<(options: PushSubscriptionOptionsInit) => Promise<typeof subscription>>(async () => {
      current = subscription
      return subscription
    }),
  }
  const register = vi.fn<(url: string) => Promise<{ pushManager: typeof pushManager }>>(async () => ({ pushManager }))
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } })
  vi.stubGlobal('PushManager', function PushManager() {})
  const notification = {
    permission: options.permission,
    requestPermission: vi.fn<() => Promise<NotificationPermission>>(async () => 'granted'),
  }
  vi.stubGlobal('Notification', notification)
  return { pushManager, register, subscription, notification }
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)

function fakeApi() {
  return {
    getPushPublicKey: vi.fn<() => Promise<string>>(async () => KEY),
    addPushSubscription: vi.fn<(subscription: PushSubscriptionInfo) => Promise<void>>(async () => {}),
    removePushSubscription: vi.fn<(endpoint: string) => Promise<void>>(async () => {}),
    sendTestNotification: vi.fn<() => Promise<number>>(async () => 1),
  }
}

describe('NotificationsSetting', () => {
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })

  async function render(api: ReturnType<typeof fakeApi>) {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<NotificationsSetting api={api as unknown as RpcStub<AuthenticatedApi>} />)
    })
    return container
  }

  it('turns on from the tap: asks permission, subscribes with the user’s key, registers the device', async () => {
    const api = fakeApi()
    const browser = installBrowser({ permission: 'default', subscribed: false })
    const container = await render(api)
    expect(browser.register).toHaveBeenCalledWith('/sw.js')

    await act(async () => button(container, 'Turn on')!.click())

    expect(browser.notification.requestPermission).toHaveBeenCalled()
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true, applicationServerKey: applicationServerKey(KEY),
    })
    expect(api.addPushSubscription).toHaveBeenCalledWith({
      endpoint: SUBSCRIPTION_JSON.endpoint, p256dh: 'P', auth: 'A',
    })
    expect(container.textContent).toContain('On for this device')
  })

  it('shows an existing subscription as on, re-registers it, and turns it off', async () => {
    const api = fakeApi()
    const browser = installBrowser({ permission: 'granted', subscribed: true })
    const container = await render(api)
    expect(container.textContent).toContain('On for this device')
    expect(api.addPushSubscription).toHaveBeenCalledTimes(1)

    await act(async () => button(container, 'Turn off')!.click())
    expect(api.removePushSubscription).toHaveBeenCalledWith(SUBSCRIPTION_JSON.endpoint)
    expect(browser.subscription.unsubscribe).toHaveBeenCalled()
    expect(button(container, 'Turn on')).toBeDefined()
  })

  it('explains a blocked permission instead of offering a switch', async () => {
    installBrowser({ permission: 'denied', subscribed: false })
    const container = await render(fakeApi())
    expect(container.textContent).toContain('blocked')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('tells iPhone users in Safari to add the app to the Home Screen', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)', maxTouchPoints: 5 })
    const container = await render(fakeApi())
    expect(container.textContent).toContain('Add to Home Screen')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
