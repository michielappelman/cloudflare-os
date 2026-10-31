// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isKeyboardOpen, isTextEntry, tallestHeightFor, type TallestHeights } from './keyboardViewport'

// iPhone portrait, 844pt tall; the keyboard takes ~336pt.
const FULL = 844
const WITH_KEYBOARD = 508

const open = (tallest: TallestHeights, height: number, textEntryFocused = true, scale = 1) =>
  isKeyboardOpen({ tallest: tallestHeightFor(tallest, 390, height), height, scale, textEntryFocused })

describe('isKeyboardOpen', () => {
  it('detects the keyboard when the installed app shrinks the whole window with it', () => {
    // interactive-widget=resizes-content: innerHeight and the visual viewport shrink together, so
    // nothing is left below the visual viewport to measure.
    const tallest: TallestHeights = new Map()
    expect(open(tallest, FULL)).toBe(false)
    expect(open(tallest, WITH_KEYBOARD)).toBe(true)
    expect(open(tallest, FULL)).toBe(false)
  })

  it('ignores a collapsing address bar', () => {
    const tallest: TallestHeights = new Map()
    open(tallest, FULL)
    expect(open(tallest, FULL - 80)).toBe(false)
  })

  it('needs a focused text field, so a short window alone is not a keyboard', () => {
    const tallest: TallestHeights = new Map()
    open(tallest, FULL)
    expect(open(tallest, WITH_KEYBOARD, false)).toBe(false)
  })

  it('ignores pinch zoom', () => {
    const tallest: TallestHeights = new Map()
    open(tallest, FULL)
    expect(open(tallest, WITH_KEYBOARD, true, 2)).toBe(false)
  })

  it('keeps each orientation separate', () => {
    const tallest: TallestHeights = new Map()
    open(tallest, FULL)
    // Landscape is short on its own; it must not be read against portrait's height.
    expect(isKeyboardOpen({
      tallest: tallestHeightFor(tallest, 844, 390), height: 390, scale: 1, textEntryFocused: true,
    })).toBe(false)
  })
})

describe('isTextEntry', () => {
  it('counts text fields and editable regions, not buttons or checkboxes', () => {
    const textarea = document.createElement('textarea')
    const text = Object.assign(document.createElement('input'), { type: 'text' })
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' })
    const readOnly = Object.assign(document.createElement('input'), { type: 'text', readOnly: true })
    expect(isTextEntry(textarea)).toBe(true)
    expect(isTextEntry(text)).toBe(true)
    expect(isTextEntry(checkbox)).toBe(false)
    expect(isTextEntry(readOnly)).toBe(false)
    expect(isTextEntry(document.createElement('button'))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })
})
