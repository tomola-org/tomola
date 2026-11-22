import { expect, it } from "vitest";
import { maskLinkTargets, protectedTitleBodyContext, restoreLinkTargets } from "~/lib/llm/link-targets.core.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { buildTranslationPrompt } from "~/lib/llm/prompt.server";
import { translateChecked } from "~/lib/llm/translate.server";

it("round trips every occurrence in a long post with similar destinations", () => {
  const destinations = Array.from({ length: 60 }, (_, i) => `https://docs.example.test/guide/${i % 11}/ja/#section-${i % 4}`);
  const source = destinations.map(url => `${"観測の手順を次の段落で説明する。".repeat(36)} [資料](${url})`).join("\n\n");
  const { text, targets, literals } = maskLinkTargets(source);
  expect(source.length).toBeGreaterThan(36_000);
  expect(text).not.toContain("https://docs.example.test");
  expect(Object.values(targets)).toEqual(destinations);
  expect(restoreLinkTargets(text, targets, literals)).toEqual({ text: source, valid: true });
});

it("uses Markdown destination boundaries and leaves code, math and HTML alone", () => {
  const source = [
    '[**label**](<https://docs.example.test/guide?q=a&amp;x=b> "caption")',
    '[![diagram](../figures/chart\\(a\\).png)](https://docs.example.test/guide)',
    '[reference][ref] <https://docs.example.test/angle> www.docs.example.test/bare。',
    '', '[ref]:', '  https://docs.example.test/ref "reference title"', '',
    '`https://kept.example.test/inline-code`', '',
    '```txt', 'https://kept.example.test/fence', '```', '',
    '    https://kept.example.test/indented', '',
    '$https://kept.example.test/inline-math$', '',
    '$$', 'https://kept.example.test/block-math', '$$', '',
    '<span data-url="https://kept.example.test/attribute">**https://kept.example.test/inline-html**</span>', '',
    '<div>', 'https://kept.example.test/html-block', '</div>',
  ].join('\r\n');
  const { text, targets, literals } = maskLinkTargets(source);
  expect(Object.values(targets)).toEqual([
    'https://docs.example.test/guide?q=a&amp;x=b', '../figures/chart\\(a\\).png', 'https://docs.example.test/guide',
    'https://docs.example.test/angle', 'www.docs.example.test/bare', 'https://docs.example.test/ref',
  ]);
  expect(text).toContain('[**label**]');
  expect(text).toContain('"caption"');
  expect(text.match(/https:\/\/kept\.example\.test\/[\w-]+/g)).toEqual(source.match(/https:\/\/kept\.example\.test\/[\w-]+/g));
  expect(restoreLinkTargets(text, targets, literals)).toEqual({ text: source, valid: true });
});

it("masks a destination before clipping the same-post title context", () => {
  const url = `https://docs.example.test/${"segment/".repeat(250)}`;
  const context = protectedTitleBodyContext(`本文 [資料](${url})`, `Body [reference](${url})`, "題");
  expect(context).toMatch(/TMLINK\d+X\d+Z/);
  expect(context).not.toContain("docs.example.test");
});

it.each(["missing", "duplicate", "unknown", "moved"] as const)("retries and flags %s markers", async fault => {
  const fake = createFakeEngine();
  const url = "https://docs.example.test/original";
  const request = { text: `[資料](${url})`, field: "body", from: "ja", to: "en" } as const;
  const notes: (string | undefined)[] = [];
  const out = await translateChecked({ ...fake, async translate(req) {
    notes.push(req.retryNote);
    expect(buildTranslationPrompt(req).user).not.toContain(url);
    const marker = req.text.match(/TMLINK\d+X\d+Z/)![0];
    const result = await fake.translate(req);
    const text = fault === "missing" ? result.text.replace(marker, "")
      : fault === "duplicate" ? `${result.text} ${marker}`
      : fault === "unknown" ? `${result.text} TMLINK99X999Z`
      : `[en] [Guide ${marker}]()`;
    return { ...result, text };
  } }, request);
  expect(out.attempts).toBe(2);
  expect(out.flags).toContain("link_mismatch");
  expect(out.text).not.toMatch(/TMLINK\d+X\d+Z/i);
  expect(notes[1]).toMatch(/keep each link marker/i);
});

it("instructs only post translators to preserve link markers", () => {
  const request = { text: "Source", from: "en", to: "ja" } as const;
  expect(buildTranslationPrompt(request).system).toMatch(/keep each link marker/i);
  for (const mode of [{ chat: { context: [] } }, { village: "name" as const }, { invitationNote: true }, { figure: true }, { nushiReading: true as const }]) {
    expect(buildTranslationPrompt({ ...request, ...mode }).system).not.toMatch(/link marker/i);
  }
});

it("keeps the Markdown prompt and original links for generated readings", async () => {
  const text = "[Guide](https://docs.example.test/reading)";
  const fake = createFakeEngine();
  const result = await translateChecked({ ...fake, async translate(req) {
    expect(req.text).toBe(text);
    return fake.translate(req);
  } }, { text, from: "en", to: "ja", nushiReading: true });
  expect(result).toMatchObject({ text: `[ja] ${text}`, flags: [], promptVersion: "translate-v14" });
});
