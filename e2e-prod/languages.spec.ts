import { state, test, useMember } from "./helpers";
import { expect } from "@playwright/test";
import { clientHeaders, enMessages, formatMessage, waitForFormReady } from "../e2e/helpers";

import fs from "node:fs";
import path from "node:path";
import { FRENCH_DRAFT } from "./member-fixtures";

test("unopened French prose preserves its language and shows a non-blocking notice", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.26.0.2") });
  const page = await context.newPage();
  try {
    const email = "language_fallback_prod@example.com";
    const { id } = JSON.parse(fs.readFileSync(path.join(state().dir, "language-draft.json"), "utf8"));
    await useMember(page, email);
    await page.goto(`/drafts/${id}`);
    await waitForFormReady(page.locator("form", { has: page.locator('input[name="title"]') }));
    await page.getByRole("button", { name: enMessages.draft_publish, exact: true }).click();
    const review = page.getByRole("dialog", { name: enMessages.signing_heading, exact: true });
    await expect(review.getByText(FRENCH_DRAFT, { exact: true })).toBeVisible();
    const notice = page.getByRole("dialog").getByRole("note");
    await expect(notice).toContainText(formatMessage(enMessages.original_lang_other_named, { lang: "French" }));
    await expect(notice.getByRole("link", { name: enMessages.languages_about, exact: true })).toHaveAttribute("href", "/languages");
    await review.getByRole("button", { name: enMessages.confirm_publish, exact: true }).click();
    await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
    const data = await (await context.request.get("/settings/export")).json();
    expect(data.entries.find((entry: { body: string }) => entry.body === FRENCH_DRAFT).lang).toBe("fr");
  } finally { await context.close(); }
});
