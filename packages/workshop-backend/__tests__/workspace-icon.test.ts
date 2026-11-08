import { describe, expect, it } from "vitest";
import { extractEmoji } from "../src/workspace-icon";

describe("extractEmoji", () => {
  it.each([
    ["📅", "📅"],
    ["  ✈️\n", "✈️"],
    ['"💰"', "💰"],
    ["Icon: 📧 (email)", "📧"],
    ["👩‍💻", "👩‍💻"],
    ["👍🏽", "👍🏽"],
    ["🇳🇱", "🇳🇱"],
    ["🚀🔥", "🚀"],
  ])("returns the first emoji grapheme of %j", (input, expected) => {
    expect(extractEmoji(input)).toBe(expected);
  });

  it.each(["", "Calendar", "C", "123"])("returns undefined when %j has no emoji", input => {
    expect(extractEmoji(input)).toBeUndefined();
  });
});
