import { expect, it, vi } from "vitest";
import { isUsablePrimary } from "~/lib/display";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { FLAG_LINK_MISMATCH, FLAG_STRUCTURE_MISMATCH, FLAG_UNTRANSLATED } from "~/lib/llm/flags";
import { protectedTitleBodyContext } from "~/lib/llm/link-targets.core.server";
import { buildTranslationPrompt, KEEP_LINK_MARKERS, promptVersionOf } from "~/lib/llm/prompt.server";
import { translateChecked } from "~/lib/llm/translate.server";
import type { TranslationRequest } from "~/lib/llm/types";

const title = { text: "『架空の報告書』を読む", field: "title", from: "ja", to: "en" } as const;
const plainTitle = "Reading “Fictional Report”";

function engineReturning(first: string, retry = first) {
  const fake = createFakeEngine();
  return { ...fake, translate: vi.fn(async (req: TranslationRequest) => ({
    ...await fake.translate(req),
    text: req.retryNote ? retry : first,
  })) };
}

it("asks for a single plain-text title with localized quotes for names of works", () => {
  const { system } = buildTranslationPrompt({ ...title, to: "fr" });
  expect(system).toContain("a single line of plain text, not Markdown");
  for (const example of ["*...*", "_..._", "**...**", "`...`", "# headings", "[label](url)", "backslash escapes", "&nbsp;"]) {
    expect(system).toContain(example);
  }
  expect(system).toContain("the target language's plain-text quotation marks or title brackets");
  expect(system).toContain("French guillemets (« ») with non-breaking spaces");
  expect(system).toContain("3. Keep every URL, identifier, file name, formula, symbol, and @mention");
  expect(system).not.toContain("The text is Markdown");
  expect(system).not.toContain("Markdown syntax");
  expect(system).toContain(KEEP_LINK_MARKERS);
});

it.each(["body", undefined] as const)("keeps the Markdown prompt for field %s", field => {
  const { system } = buildTranslationPrompt({ ...title, field });
  expect(system).toContain("The text is Markdown. Keep its structure exactly");
  expect(system).toContain("Markdown syntax");
});

it("keeps title body context and terminology in their own sections", () => {
  const { system, user } = buildTranslationPrompt({ ...title, titleBodyContext: "Same-post context", terminology: { author: ["Fictional Report"] } }, "abcd");
  expect(system).toMatch(/^7\. .*<title_body_context-NONCE>/m);
  expect(system).toMatch(/^10\. .*<post_terminology-NONCE>/m);
  expect(user).toContain("<title_body_context-abcd>\nSame-post context\n</title_body_context-abcd>");
  expect(user).toContain('<post_terminology-abcd>\n{"author":["Fictional Report"]}\n</post_terminology-abcd>');
});

it("versions post prompts together and preserves dedicated prompts", () => {
  for (const field of ["title", "body"] as const) {
    const req = { ...title, field };
    expect(promptVersionOf(req)).toBe("translate-v16");
    expect(promptVersionOf({ ...req, from: "other" })).toBe("translate-other-v4");
  }
  const modes: [Partial<TranslationRequest>, string][] = [
    [{ nushiReading: true }, "translate-v14"],
    [{ chat: { context: [] } }, "chat-v4"],
    [{ village: "name" }, "village-v2"],
    [{ invitationNote: true }, "invitation-note-v1"],
    [{ figure: true }, "figure-translation-v4"],
  ];
  for (const [mode, version] of modes) {
    const req = { ...title, ...mode };
    expect(promptVersionOf(req)).toBe(version);
    expect(promptVersionOf({ ...req, from: "other" })).toBe("translate-other-v2");
    expect(buildTranslationPrompt(req).system).toBe(buildTranslationPrompt({ ...req, field: undefined }).system);
  }
});

it.each([
  "Reading *Fictional Report*", "Reading _Fictional Report_", "Reading **Fictional Report**",
  "Reading ~~Fictional Report~~", "Reading `Fictional Report`", "```\nFictional Report\n```",
  "# Fictional Report", "> Fictional Report", "- Fictional Report", "![Fictional Report](cover.png)",
  "Read [Fictional Report](#report)", "Reading\nFictional Report", "Reading&NewLine;Fictional Report",
])("retries titles with new formatting or line breaks: %j", async output => {
  const engine = engineReturning(`[en] ${output}`, plainTitle);
  expect(await translateChecked(engine, title)).toMatchObject({ attempts: 2, flags: [], text: plainTitle });
  expect(engine.translate.mock.calls[0][0].retryNote).toBeUndefined();
  const retry = engine.translate.mock.calls[1][0].retryNote;
  expect(retry).toContain("a single line of plain text, not Markdown");
  expect(retry).toContain("instead of Markdown italics");
});

it.each(["Reading *Fictional Report*", "# Fictional Report", "Reading\n\nFictional Report"])("keeps persistent title formatting visible: %j", async text => {
  const out = await translateChecked(engineReturning(text), title);
  expect(out).toMatchObject({ attempts: 2, text, flags: [FLAG_STRUCTURE_MISMATCH] });
  expect(isUsablePrimary({ ...out, sourceHash: "current" }, "current")).toBe(true);
});

it.each([
  ["A* 探索", "A* search"],
  ["例は 2 * 3 = 6", "Example: 2 * 3 = 6"],
  ["識別子 foo_bar_baz", "Identifier foo_bar_baz"],
  ["5ドルと10ドルのプラン", "The $5 and $10 plans"],
  ["*架空の報告書*を読む", "Reading *Fictional Report*"],
  ["# 架空の報告書", "# Fictional Report"],
  ["架空の報告書を\n読む", "Reading\nFictional Report"],
])("keeps literal or source-authored syntax: %s", async (source, text) => {
  expect(await translateChecked(engineReturning(text), { ...title, text: source })).toMatchObject({ attempts: 1, flags: [], text });
});

it("retries an extra occurrence of a Markdown node already in the source", async () => {
  const engine = engineReturning("*Reading* *Fictional Report*", "Reading *Fictional Report*");
  expect(await translateChecked(engine, { ...title, text: "*架空の報告書*を読む" })).toMatchObject({ attempts: 2, flags: [] });
});

it.each([
  ["『架空の案内』を読む", "Lecture de «&nbsp;Guide&nbsp;»", "Lecture de «\u00a0Guide\u00a0»"],
  ["HTML の &nbsp; の扱い", "Le caractère &nbsp;&nbsp;: un exemple", "Le caractère &nbsp;\u00a0: un exemple"],
])("decodes only added HTML entities: %s", async (source, output, text) => {
  expect(await translateChecked(engineReturning(output), { ...title, text: source, to: "fr" })).toMatchObject({ attempts: 1, flags: [], text });
});

it("still flags a source copy disguised with a space entity", async () => {
  const text = "Reading the fictional report about the lighthouse";
  const engine = engineReturning(text.replace("the fictional", "the&nbsp;fictional"));
  expect(await translateChecked(engine, { ...title, text, from: "en", to: "fr" })).toMatchObject({
    attempts: 2, text: text.replace("the fictional", "the\u00a0fictional"), flags: [FLAG_UNTRANSLATED],
  });
});

it("keeps the existing hidden flag for an invented URL", async () => {
  const engine = engineReturning("Read https://example.test/report");
  expect(await translateChecked(engine, title)).toMatchObject({ attempts: 2, flags: [FLAG_LINK_MISMATCH] });
});

it.each(["https://example.test/guide?q=&nbsp;item", "www.example.test/guide?q=&nbsp;item"])("protects title URL %s and body context destinations", async titleUrl => {
  const bodyUrl = "https://example.test/context";
  const text = `案内 ${titleUrl}`;
  const titleBodyContext = protectedTitleBodyContext(`本文 [資料](${bodyUrl})`, `Body [reference](${bodyUrl})`, text);
  const fake = createFakeEngine();
  const out = await translateChecked({ ...fake, async translate(req) {
    const { user } = buildTranslationPrompt(req);
    expect(user).not.toContain(titleUrl);
    expect(user).not.toContain(bodyUrl);
    expect(req.titleBodyContext).toMatch(/TMLINK\d+X\d+Z/);
    expect(req.text).toMatch(/TMLINK\d+X\d+Z/);
    const result = await fake.translate(req);
    return { ...result, text: result.text.replace("案内", "Guide&ensp;Notes") };
  } }, { ...title, text, titleBodyContext });
  expect(out).toMatchObject({ text: `[en] Guide\u2002Notes ${titleUrl}`, attempts: 1, flags: [] });
});
