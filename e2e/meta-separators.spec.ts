import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { enMessages, formatMessage, openUserMenu, state, useMember, visitListRow, waitForClientRoute } from "./helpers";

async function expectWordBoundaries(row: Locator) {
  const items = row.locator(".topic-row-meta [data-meta-item]");
  expect(await items.count()).toBeGreaterThan(0);
  const structure = await items.evaluateAll(nodes => nodes.map(item => {
    const space = item.firstElementChild;
    return item.getBoundingClientRect().width > 0 && space?.textContent === " "
      && getComputedStyle(space).position === "absolute" && !space.hasAttribute("aria-hidden");
  }));
  expect(structure).toEqual(structure.map(() => true));

  const collisions = await row.evaluate(element => {
    const within = [...element.querySelectorAll(".topic-title, [data-meta-item]")];
    return within.flatMap((item, index) => within.slice(index + 1).flatMap(other => {
      const overlap = [...item.getClientRects()].some(a => [...other.getClientRects()].some(b =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5));
      return overlap ? [[item.getAttribute("data-meta-item") ?? "title", other.getAttribute("data-meta-item")]] : [];
    }));
  });
  expect(collisions).toEqual([]);
}

async function expectSharedColumns(rich: Locator, plain: Locator) {
  const horizontal = (row: Locator) => row.evaluate(element => ({
    dateStart: element.querySelector("time")!.getBoundingClientRect().left,
    replyEnd: element.querySelector('[data-meta-item="replies"]')!.getBoundingClientRect().right,
  }));
  expect(await horizontal(rich)).toEqual(await horizontal(plain));
  const baselines = await rich.evaluate(row => {
    const title = row.querySelector(".topic-title")!;
    const author = row.querySelector('[data-meta-item="author"] a')!;
    const range = document.createRange();
    range.selectNodeContents(title);
    const titleLines = new Set([...range.getClientRects()].map(rect => rect.top)).size;
    const baseline = (element: Element) => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block; inline-size:0; block-size:0";
      element.prepend(probe);
      const position = probe.getBoundingClientRect().bottom;
      probe.remove();
      return position;
    };
    return { title: baseline(title), author: baseline(author), titleLines };
  });
  expect(baselines.titleLines).toBeGreaterThan(1);
  expect(Math.abs(baselines.author - baselines.title)).toBeLessThan(1);
}

async function expectNarrowOrder(row: Locator) {
  const author = (await row.locator('[data-meta-item="author"]').boundingBox())!;
  const date = (await row.locator("time").boundingBox())!;
  if (author.y + author.height > date.y) {
    expect(author.x + author.width).toBeLessThanOrEqual(date.x);
  } else {
    expect(author.y).toBeLessThan(date.y);
  }
}

test("list metadata separates optional items and stays readable when it wraps", async ({ page }) => {
  test.skip(!process.env.E2E_PUBLIC_READING && process.env.E2E_VILLAGES !== "1", "The rich metadata fixture requires villages.");
  const fixture: { rich: number; plain: number } = JSON.parse(fs.readFileSync(path.join(state().dir, "meta-separators.json"), "utf8"));
  await useMember(page, "listmeta_reader@example.com");
  let richHome = "";
  for (const [name, id] of Object.entries(fixture)) {
    const row = page.locator(`#q-${id}`);
    await visitListRow(page, "/?lang=en", row);
    if (name === "rich") richHome = page.url();
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expectWordBoundaries(row);
      const village = row.locator('a[href="/v/meta-separators"]');
      await expect(village).toHaveCount(name === "rich" ? 1 : 0);
      await expect(row.locator(".sr-only").filter({ hasText: /\S/ })).toHaveCount(name === "rich" ? 1 : 0);
      if (name === "rich") {
        await expect(village).toHaveAttribute("title", await village.innerText());
        expect(await village.evaluate(link => link.scrollWidth > link.clientWidth)).toBe(true);
        await expect(row.getByText(formatMessage(enMessages.label_from_lang_machine, { lang: enMessages.language_name_ja }), { exact: true })).toBeVisible();
        expect(await row.locator("[data-meta-item]").count()).toBeGreaterThan(4);
        if (width === 390) {
          const lines = await row.locator("[data-meta-item]").evaluateAll(items => new Set(items.map(item => item.getBoundingClientRect().top)).size);
          expect(lines).toBeGreaterThan(1);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  const latestRow = page.locator(`#q-${fixture.rich}`);
  await visitListRow(page, "/latest?lang=en", latestRow);
  const plainRow = latestRow.locator("..").locator(`#q-${fixture.plain}`);
  await expect(plainRow).toBeVisible();
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await expectWordBoundaries(latestRow);
    await expect(latestRow.locator('[data-meta-item="translation"] [data-slot="badge"]')).toHaveCount(1);
    if (width === 1366) await expectSharedColumns(latestRow, plainRow);
    else await expectNarrowOrder(latestRow);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  for (const locale of ["en", "ja"]) {
    if (locale === "ja") {
      const menu = await openUserMenu(page);
      await menu.getByRole("menuitem", { name: enMessages.nav_language, exact: true }).click();
      await page.getByRole("menuitemradio", { name: "日本語", exact: true }).click();
    }
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.goto(richHome);
    await waitForClientRoute(page);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expectWordBoundaries(page.locator(`#q-${fixture.rich}`));
      await page.locator(`#q-${fixture.rich}`).scrollIntoViewIfNeeded();
      if (process.env.E2E_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `home-${locale}-${width}.png`), animations: "disabled" });
      }
    }
  }
});

test("replies reach the author column edge when the list has no insightful counts", async ({ page }) => {
  const id: number = JSON.parse(fs.readFileSync(path.join(state().dir, "meta-end.json"), "utf8"));
  await page.setViewportSize({ width: 1366, height: 900 });
  await useMember(page, "listmeta_edge_writer@example.com", "/saved?lang=en");
  const row = page.locator(`#q-${id}`);
  const author = row.locator('[data-meta-item="author"]');
  const replies = row.locator('[data-meta-item="replies"]');
  await expect(row).toBeVisible();
  await expect(row.locator("..").locator('[data-meta-item="insightful"]')).toHaveCount(0);
  await expect(replies).toBeVisible();
  await expect(author).toBeVisible();
  const [replyBox, authorBox] = await Promise.all([replies.boundingBox(), author.boundingBox()]);
  expect(replyBox!.x + replyBox!.width).toBeCloseTo(authorBox!.x + authorBox!.width, 0);
});
