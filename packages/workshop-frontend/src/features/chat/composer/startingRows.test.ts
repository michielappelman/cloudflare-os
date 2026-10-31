// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startingRows } from './useComposerEditorLayout'

const screenIs = (phone: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
  matches: phone && query === '(max-width: 767px)',
}))

afterEach(() => vi.unstubAllGlobals())

describe('startingRows', () => {
  it('starts the composer at one line on a phone, whatever the caller asks', () => {
    screenIs(true)
    expect(startingRows(2)).toBe(1)
  })

  it("keeps the caller's minimum on larger screens", () => {
    screenIs(false)
    expect(startingRows(2)).toBe(2)
    expect(startingRows(1)).toBe(1)
  })
})
