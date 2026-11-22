import fs from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as en, state, useMember, waitForFormReady } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator, installSeededSigningKey } from "./signing-helper";

async function create(page: Page, kind: "topic" | "reply") {
  const headers = { origin: state().baseURL };
  const displayed = page.locator('input[name="villageDisplayed"]');
  const destination: Record<string, string> = await displayed.count() ? { villageDisplayed: await displayed.inputValue() } : {};
  const topic = await page.request.post("/t/new", { headers, form: { title: "Version A", body: "Body A", lang: "en", asksStance: kind === "reply" ? "1" : "0", ...destination }, maxRedirects: 0 });
  expect(topic.status()).toBe(302);
  const topicPath = new URL(topic.headers().location, state().baseURL).pathname;
  if (kind === "topic") return `${topicPath}/edit`;
  const reply = await page.request.post(topicPath, { headers, form: { body: "Body A", lang: "en", stanceTag: "agree" }, maxRedirects: 0 });
  expect(reply.status()).toBe(302);
  const id = /#c-(\d+)/.exec(reply.headers().location)![1];
  return `/c/${id}/edit`;
}

for (const kind of ["topic", "reply"] as const) for (const signed of [false, true]) {
  test(`${kind}: two screens preserve the refused edit and its device copy, signing ${signed}`, async ({ page, context }) => {
    await useMember(page, `edit_version_${kind}_${signed ? "signed" : "plain"}@example.com`, "/t/new");
    const authenticator = signed ? await installSeededSigningKey(page, `edit_version_${kind}_signed@example.com`) : null;
    const path = signed
      ? JSON.parse(fs.readFileSync(join(state().dir, "signed-edit-targets.json"), "utf8"))[kind] as string
      : await create(page, kind);
    const stale = await context.newPage();
    await page.goto(path);
    await stale.goto(path);
    const form = stale.locator("form", { has: stale.locator('[name="body"]') });
    await waitForFormReady(form);
    await waitForFormReady(page.locator("form", { has: page.locator('[name="body"]') }));
    const version = await stale.locator('[name="editVersion"]').inputValue();
    await stale.locator('textarea[name="body"]').fill("My unsent C");
    if (kind === "topic") await stale.locator('[name="title"]').fill("My title C");
    else {
      await stale.getByRole("combobox", { name: en.stance_tag_label, exact: true }).click();
      await stale.getByRole("option", { name: en.stance_tag_neither, exact: true }).click();
    }
    await page.locator('textarea[name="body"]').fill("Saved B");
    await page.getByRole("button", { name: en.save_changes, exact: true }).click();
    if (signed) await acceptSignedWrite(page);
    await expect(page).not.toHaveURL(/\/edit$/);
    if (authenticator) {
      const next = await enableSigningAuthenticator(stale);
      const { credentials } = await authenticator.client.send("WebAuthn.getCredentials", { authenticatorId: authenticator.authenticatorId });
      for (const credential of credentials) await next.client.send("WebAuthn.addCredential", { authenticatorId: next.authenticatorId, credential });
    }
    const response = stale.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith(path));
    await stale.getByRole("button", { name: en.save_changes, exact: true }).click();
    if (signed) await acceptSignedWrite(stale);
    expect((await response).status()).toBe(409);
    await expect(stale.getByRole("alert")).toContainText(en.edit_conflict);
    await expect(stale.locator('textarea[name="body"]')).toHaveValue("My unsent C");
    if (kind === "topic") await expect(stale.locator('[name="title"]')).toHaveValue("My title C");
    else await expect(stale.locator('input[name="stanceTag"]')).toHaveValue("neither");
    await expect(stale.locator('[name="editVersion"]')).toHaveValue(version);
    await expect.poll(() => stale.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("tomola:draft:")).some(([, value]) => {
      try { return JSON.parse(value).body === "My unsent C"; } catch { return false; }
    }))).toBe(true);
    const latest = stale.getByRole("link", { name: en.edit_open_latest, exact: true });
    await expect(latest).toHaveAttribute("href", path);
    await expect(latest).toHaveAttribute("target", "_blank");
    const popup = stale.waitForEvent("popup");
    await latest.click();
    const current = await popup;
    await expect(current.locator('textarea[name="body"]')).toHaveValue("Saved B");
    await expect(stale.locator('textarea[name="body"]')).toHaveValue("My unsent C");
    await current.close();
    await stale.close();
  });
}

for (const kind of ["topic", "reply"] as const) {
  test(`${kind}: a native POST keeps the rejected fields and the original version without JavaScript`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await useMember(page, `edit_version_${kind}_native@example.com`, "/t/new");
      const path = await create(page, kind);
      const other = await context.newPage();
      await page.goto(path);
      await other.goto(path);
      const version = await page.locator('[name="editVersion"]').inputValue();
      await page.locator('textarea[name="body"]').fill("Native unsent C");
      if (kind === "topic") await page.locator('[name="title"]').fill("Native title C");
      await other.locator('textarea[name="body"]').fill("Native saved B");
      await other.getByRole("button", { name: en.save_changes, exact: true }).click();
      await expect(other).not.toHaveURL(/\/edit$/);
      const response = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === path);
      await page.getByRole("button", { name: en.save_changes, exact: true }).click();
      expect((await response).status()).toBe(409);
      await expect(page.getByRole("alert")).toContainText(en.edit_conflict);
      await expect(page.locator('textarea[name="body"]')).toHaveValue("Native unsent C");
      if (kind === "topic") await expect(page.locator('[name="title"]')).toHaveValue("Native title C");
      await expect(page.locator('[name="editVersion"]')).toHaveValue(version);
      const latest = page.getByRole("link", { name: en.edit_open_latest, exact: true });
      await expect(latest).toHaveAttribute("href", path);
      await expect(latest).toHaveAttribute("target", "_blank");
      // A repeated native POST still uses A; the error must not silently rebase it onto B.
      await page.getByRole("button", { name: en.save_changes, exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(en.edit_conflict);
      await expect(page.locator('textarea[name="body"]')).toHaveValue("Native unsent C");
    } finally { await context.close(); }
  });
}
