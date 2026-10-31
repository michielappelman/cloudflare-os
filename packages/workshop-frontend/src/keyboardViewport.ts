// Whether the on-screen keyboard is up, from what the browser reports about the viewport.
//
// There is no keyboard API to ask. Browsers differ in what the keyboard shrinks: Safari in a tab
// shrinks only the visual viewport, while an installed iOS app honouring
// `interactive-widget=resizes-content` shrinks the layout viewport (`innerHeight`) with it, so the
// gap between the two stays zero. What both have in common is that the visible height drops well
// below the tallest it has been in the current orientation while a text field has focus.

/** Below this many pixels, a shorter viewport is browser chrome (a collapsing address bar). */
export const KEYBOARD_MIN_HEIGHT = 120;

/** The tallest visible height seen per viewport width, which stands in for orientation. */
export type TallestHeights = Map<number, number>;

/** Records `height` for `width` and returns the tallest height seen at that width. */
export const tallestHeightFor = (tallest: TallestHeights, width: number, height: number): number => {
  const key = Math.round(width);
  const seen = Math.max(tallest.get(key) ?? 0, height);
  tallest.set(key, seen);
  return seen;
};

/** Whether `element` takes text input, so focusing it brings up the on-screen keyboard. */
export const isTextEntry = (element: Element | null): boolean => {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && !['button', 'checkbox', 'color', 'file', 'hidden', 'image',
      'radio', 'range', 'reset', 'submit'].includes(element.type);
  }
  // An iframe is a configurator frame, whose fields the parent page cannot see into.
  return element instanceof HTMLIFrameElement || (element as HTMLElement).isContentEditable === true;
};

/**
 * Whether the keyboard is up: a text field has focus, the page is not pinch-zoomed, and the visible
 * height is well below the tallest seen at this width.
 */
export const isKeyboardOpen = (state: {
  tallest: number;
  height: number;
  scale: number;
  textEntryFocused: boolean;
}): boolean =>
  state.textEntryFocused && state.scale < 1.01 && state.tallest - state.height > KEYBOARD_MIN_HEIGHT;
