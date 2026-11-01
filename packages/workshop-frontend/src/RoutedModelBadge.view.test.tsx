// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { makeTestRoot } from './action-test-harness'
import { RoutedModelBadge } from './RoutedModelBadge'

const root = makeTestRoot()
afterEach(() => root.unmount())

describe('RoutedModelBadge', () => {
  it('opens the routing details on a click or tap, led by the recorded name', async () => {
    await root.render(<RoutedModelBadge routings={[
      { model: 'anthropic/claude-haiku-5.5', name: 'Haiku 5.5', reason: 'cost_optimal_within_pool',
        inputTokens: 12400, outputTokens: 310, durationMs: 2100 },
      { model: 'openai/gpt-6-luna', reason: 'pinned_by_turn' },
    ]} />)

    const trigger = document.querySelector('button')!
    expect(trigger.textContent).toContain('Haiku 5.5')
    expect(trigger.textContent).toContain('gpt-6-luna')
    expect(document.body.textContent).not.toContain('Best quality for the cost')

    await act(async () => trigger.click())

    const text = document.body.textContent ?? ''
    expect(text).toContain('Auto Router · 2 requests')
    expect(text).toContain('anthropic/claude-haiku-5.5')
    expect(text).toContain('Best quality for the cost')
    expect(text).toContain('12.4k in · 310 out · 2.1 s')
    expect(text).toContain('Pinned for this turn')
  })
})
