import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, messageTitleField, useMember, waitForFormReady, waitForHydration } from "./helpers";

test("a reader can choose a stance after reloading the current wording", async ({ page: author, browser }) => {
  await useMember(author, "stance_version_author@example.com", "/t/new");
  const title = messageTitleField(author);
  await waitForFormReady(author.locator("form", { has: title }));
  await title.fill("The library should open earlier");
  await author.getByLabel(en.field_body).fill("Opening two hours earlier would serve commuters.");
  await author.getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true }).check();
  await author.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(author.getByRole("heading", { level: 1, name: "The library should open earlier" })).toBeVisible();
  const question = new URL(author.url()).pathname;
  const context = await browser.newContext();
  try {
    const reader = await context.newPage();
    await useMember(reader, "stance_version_reader@example.com", question);
    await waitForHydration(reader);
    await expect(reader.getByRole("heading", { level: 1, name: "The library should open earlier" })).toBeVisible();

    await author.goto(`${question}/edit`);
    await waitForFormReady(author.locator("form", { has: title }));
    await title.fill("The library should stay open later");
    await author.getByLabel(en.field_body).fill("An evening schedule would serve commuters.");
    await author.getByRole("button", { name: en.save_changes, exact: true }).click();
    await expect(author.getByRole("heading", { level: 1, name: "The library should stay open later" })).toBeVisible();

    const panel = reader.locator("#stance");
    const agree = panel.getByRole("button", { name: en.stance_agree, exact: true });
    const response = reader.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/stance.data");
    await agree.click();
    expect((await response).status()).toBe(409);
    await expect(panel.getByRole("status")).toHaveText(en.stance_question_changed);
    await expect(agree).toHaveAttribute("aria-pressed", "false");
    await expect(panel.getByRole("list", { name: en.stance_counts_label })).toHaveCount(0);

    await panel.getByRole("button", { name: en.offline_reload }).click();
    await expect(reader.getByRole("heading", { level: 1, name: "The library should stay open later" })).toBeVisible();
    await expect(panel.getByText(en.stance_question_changed)).toHaveCount(0);
    await expect(agree).toHaveAttribute("aria-pressed", "false");
    await waitForHydration(reader);
    await agree.click();
    await expect(agree).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByRole("list", { name: en.stance_counts_label })).toBeVisible();
  } finally {
    await context.close();
  }
});
