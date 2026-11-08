// Helpers for the emoji icon the quick model picks for each workspace (see
// Overseer.generateWorkspaceIcon()).

/** Titles a workspace carries before the user or the quick model has named it. */
export const DEFAULT_WORKSPACE_TITLES: readonly string[] = ["Untitled Gadget", "Untitled Workspace"];

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_PAIR = /^\p{Regional_Indicator}{2}$/u;

/**
 * The first emoji in a model completion, as one grapheme cluster (so ZWJ sequences, skin tones,
 * keycaps and flags survive intact), or undefined if the completion contains none. Models
 * sometimes wrap the emoji in quotes or add a word of explanation; those are ignored.
 */
export function extractEmoji(text: string): string | undefined {
  let segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (let { segment } of segmenter.segment(text.trim())) {
    if (PICTOGRAPHIC.test(segment) || REGIONAL_INDICATOR_PAIR.test(segment)) return segment;
  }
  return undefined;
}
