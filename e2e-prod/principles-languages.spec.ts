import { expect, test } from "./helpers";
import { PRINCIPLES_LANGS, principlesLanguageGroups } from "../app/lib/principles-languages";
import { jaMessages } from "../e2e/helpers";
import { expectedPrinciplesStatus, readPrinciplesSource } from "../tests/helpers/principles-source";

test.use({ locale: "ja-JP" });

test("all seventeen principles editions are public with only Japanese and English enabled", async ({ page, request }) => {
  await page.goto("/principles");
  await expect(page.locator("article")).toHaveAttribute("lang", "ja");
  for (const lang of PRINCIPLES_LANGS) {
    // The languages one can join in are on a line; the others are in a fold, which opens by itself when the page is shown in one of them.
    const nav = page.getByRole("navigation", { name: jaMessages.principles_langs_label, exact: true });
    if (await nav.locator('[aria-current="page"]').getAttribute("lang") !== lang) {
      const fold = nav.locator("details");
      if (!(await fold.evaluate(element => (element as HTMLDetailsElement).open)) && await fold.locator(`a[lang="${lang}"]`).count()) await fold.locator("summary").click();
      await nav.locator(`a[lang="${lang}"]`).click();
    }
    const source = readPrinciplesSource(lang);
    await expect(page.locator("article")).toHaveAttribute("lang", lang);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(source.title);
    await expect(page.locator("article h2")).toHaveText(source.headings);
    await expect(page.locator("#s7 li")).toHaveCount(2);
    expect(await page.locator("article").textContent()).not.toContain("{{principles-");
    for (const comment of source.comments) expect(await page.locator("article").textContent()).not.toContain(comment);
    await expect(nav.locator("a")).toHaveCount(PRINCIPLES_LANGS.length - 1);
    await expect(nav.locator("ul")).toHaveCount(2);
    const { open, readOnly } = principlesLanguageGroups(["ja", "en"]);
    const rows = [open, readOnly];
    for (const [index, langs] of rows.entries()) expect(await nav.locator("ul").nth(index).locator("[lang]").evaluateAll(items => items.map(item => item.getAttribute("lang")))).toEqual(langs);
    await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", lang === "ja" ? "/principles.md" : `/principles.md?lang=${lang}`);
    await expect(page.getByRole("note")).toHaveCount(0);
    if (source.notice) await expect(page.locator("article p").first()).toHaveText(source.notice);
    else await expect(page.getByText("Unverified machine translation", { exact: true })).toHaveCount(0);
    const response = await request.get(`/principles.md?lang=${lang}`);
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain(source.markdown);
    expect(body).toContain(`\nlang: ${lang}\n`);
    expect(body).toContain(`\nstatus: ${expectedPrinciplesStatus(lang)}\n`);
    expect(body).not.toContain("requested_lang:");
    for (const comment of source.comments) expect(body).not.toContain(comment);
  }
});

test("Indonesian and Spanish each appear once as supported languages when closed", async ({ page }) => {
  await page.goto("/languages");
  for (const lang of ["id", "es"]) {
    await expect(page.locator(`main bdi[lang="${lang}"]`)).toHaveCount(1);
    await expect(page.locator(`section[aria-labelledby="languages-supported"] bdi[lang="${lang}"]`)).toBeVisible();
  }
  await page.getByRole("main").getByRole("link", { name: jaMessages.footer_principles, exact: true }).click();
  await expect(page).toHaveURL(/\/principles#s2$/);
  await expect(page.locator("#s2")).toBeVisible();
});
