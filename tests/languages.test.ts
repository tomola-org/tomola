import { describe, expect, it } from "vitest";
import { AREAS, LANGS, LANG_LABELS, isArea, isLang } from "~/lib/languages";

describe("languages", () => {
  it("has the eleven language tags in order", () => {
    expect(LANGS).toEqual(["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi", "id", "es"]);
  });

  it("areas are the languages plus other", () => {
    expect(AREAS).toEqual([...LANGS, "other"]);
  });

  it("recognizes language tags exactly", () => {
    expect(isLang("zh-Hant")).toBe(true);
    expect(isLang("zh")).toBe(false);
    expect(isLang("other")).toBe(false);
    expect(isLang(42)).toBe(false);
  });

  it("recognizes areas", () => {
    expect(isArea("other")).toBe(true);
    expect(isArea("th")).toBe(true);
    expect(isArea("id")).toBe(true);
    expect(isArea("es")).toBe(true);
    expect(isArea("pt")).toBe(false);
  });

  it("has a label for every language", () => {
    for (const lang of LANGS) {
      expect(LANG_LABELS[lang].length).toBeGreaterThan(0);
    }
  });
});
