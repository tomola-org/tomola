import { enMessages as en, openPostSettings, waitForFormReady } from "../e2e/helpers";
import { expect, state, test, useMember, watchCsp } from "./helpers";
import { YOUTUBE_CARD_AUTHOR, YOUTUBE_CARD_READER } from "./member-fixtures";

test("a published video link gets a local thumbnail in the original and translated body", async ({ page, browser }) => {
  test.skip(process.env.VIDEO_CARDS !== undefined && process.env.VIDEO_CARDS !== "1", "Video cards are explicitly disabled");
  const watch = await watchCsp(page);
  const external: string[] = [];
  const origin = state().baseURL;
  const inspect = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) external.push(url.href);
  };
  page.on("request", inspect);
  await page.route(url => url.origin !== origin && /^https?:$/.test(url.protocol), route => route.abort());
  await useMember(page, YOUTUBE_CARD_AUTHOR);
  await page.setViewportSize({ width: 380, height: 760 });
  await page.goto("/t/new");
  const form = page.locator("form", { has: page.getByLabel(en.report_field_title) });
  await waitForFormReady(form);
  const title = "ウェビナーの録画";
  const link = "https://youtu.be/A1b2C3d4_-E?t=45&list=example";
  await page.getByLabel(en.report_field_title).fill(title);
  await form.locator('textarea[name="body"]').fill(`録画を共有します。\n\n${link}`);
  await openPostSettings(page);
  await page.getByLabel(en.field_lang).click();
  await page.getByRole("listbox").getByRole("option", { name: "日本語", exact: true }).click();
  await page.getByRole("button", { name: en.draft_save_and_preview, exact: true }).click();
  await expect(page.locator("[data-reading-body]").getByRole("link", { name: link })).toBeVisible();
  await page.getByRole("button", { name: en.draft_preview_publish, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/t\/\d+\/?$/.test(url.pathname));
  const article = new URL(page.url()).pathname;
  const card = page.locator("[data-reading-body] .video-card");
  await expect(async () => {
    await page.goto(article);
    await expect(card).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });
  await expect(card).toHaveAttribute("href", link);
  await expect(card).toHaveAttribute("rel", "nofollow noopener noreferrer");
  await expect(card).toContainText("Example video");
  await expect(card).toContainText("Example channel");
  await expect(card.locator(".video-card-note")).toHaveCount(0);
  const image = card.locator("img");
  await expect(image).toHaveAttribute("src", /^\/media\/youtube-[\w-]+\.webp$/);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  const bounds = (await card.boundingBox())!;
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await card.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(card).toBeFocused();
  await expect(card).toHaveCSS("outline-style", "solid");
  const markdown = await page.request.get(`${article}.md`);
  expect(markdown.ok()).toBe(true);
  const source = await markdown.text();
  expect(source).toContain(link);
  expect(source).not.toContain("video-card");

  const readerContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const reader = await readerContext.newPage();
    const translatedCsp = await watchCsp(reader);
    reader.on("request", inspect);
    await reader.route(url => url.origin !== origin && /^https?:$/.test(url.protocol), route => route.abort());
    await useMember(reader, YOUTUBE_CARD_READER);
    const translated = reader.locator("[data-reading-body] .video-card");
    await expect(async () => {
      await reader.goto(`${article}?sl=en`);
      await expect(translated.getByText(en.md_video_original, { exact: true })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 45_000 });
    await expect(translated).toHaveAttribute("href", link);
    await expect(translated.getByText(en.md_video_youtube, { exact: true })).toBeVisible();
    await expect(translated.locator("img")).toHaveAttribute("src", await image.getAttribute("src") ?? "");
    expect(translatedCsp.violations).toEqual([]);
  } finally {
    await readerContext.close();
  }
  expect(external).toEqual([]);
  expect(watch.violations).toEqual([]);
});
