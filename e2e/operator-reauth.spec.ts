import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { confirmMagicLink, enMessages as m, formatMessage, loginCodeFor, logSize, magicLinkFor, state, useMember, waitForClientRoute } from "./helpers";

async function verifyIdentity(page: Page, email: string, method: "code" | "link") {
  const since = logSize();
  await page.getByRole("button", { name: m.reauth_submit, exact: true }).click();
  const code = page.getByLabel(m.login_code_label, { exact: true });
  await expect(code).toBeVisible();
  if (method === "link") await confirmMagicLink(page, await magicLinkFor(email, since));
  else {
    await code.fill(await loginCodeFor(email, since));
    await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
  }
}

test("an operator returns to member search and to a post after re-verifying", async ({ page }) => {
  const email = "reauth_operator@example.com";
  const destination = "/admin/roles?q=reauth_target";
  const clock = path.join(state().dir, "server-clock.txt");
  const previous = fs.readFileSync(clock, "utf8");
  const topic: { id: number } = JSON.parse(fs.readFileSync(path.join(state().dir, "reauth-topic.json"), "utf8"));
  const otherTab = await page.context().newPage();
  const sessionCookie = async () => (await page.context().cookies()).find(cookie => cookie.name.endsWith("better-auth.session_token"))?.value;
  const verify = async (markedReturn: string, cleanReturn: string, method: "code" | "link") => {
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "moderation" && url.searchParams.get("next") === markedReturn);
    await expect(page.getByText(formatMessage(m.reauth_for_moderation, { who: "@reauth_operator" }), { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: m.reauth_cancel, exact: true })).toHaveAttribute("href", cleanReturn);
    await verifyIdentity(page, email, method);
    const notice = page.getByRole("status").filter({ hasText: m.reauth_action_pending });
    await expect(page).toHaveURL(markedReturn);
    await expect(notice).toBeVisible();
    await waitForClientRoute(page);
    await expect(page).toHaveURL(cleanReturn, { timeout: 12_000 });
    await expect(notice).toBeVisible();
  };
  try {
    await useMember(page, email, destination);
    await waitForClientRoute(page);
    await otherTab.goto("/settings");
    await waitForClientRoute(otherTab);
    const displayName = otherTab.locator("#settings-display-name");
    await displayName.locator('input[name="displayName"]').fill("Verified Operator");
    const originalSession = await sessionCookie();
    expect(originalSession).toBeTruthy();
    const member = page.getByRole("listitem").filter({ hasText: "@reauth_target" });
    const suspend = member.getByRole("button", { name: m.mod_suspend, exact: true });
    const note = suspend.locator("xpath=ancestor::form").getByLabel(m.mod_note_short, { exact: true });
    await note.fill("Repeated unsolicited advertising.");
    fs.writeFileSync(clock, String(25 * 3_600_000));
    await suspend.click();
    await verify(`${destination}&reverified=1`, destination, "code");
    expect(await sessionCookie()).not.toBe(originalSession);
    await displayName.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(displayName.getByRole("status")).toHaveText(m.settings_saved);
    await expect(displayName.locator('input[name="displayName"]')).toHaveValue("Verified Operator");
    await expect(suspend).toBeVisible();
    await expect(note).toHaveValue("");

    const post = `/t/${topic.id}`;
    await page.goto(post);
    await waitForClientRoute(page);
    const panel = page.locator("summary").filter({ hasText: m.mod_panel_summary });
    await panel.click();
    await page.getByLabel(m.mod_note, { exact: true }).fill("Review the wording of this post.");
    const hide = page.getByRole("button", { name: m.mod_hide, exact: true });
    fs.writeFileSync(clock, String(50 * 3_600_000));
    await hide.click();
    const beforeLink = await sessionCookie();
    await verify(`${post}?reverified=1#p-${topic.id}`, `${post}#p-${topic.id}`, "link");
    expect(await sessionCookie()).not.toBe(beforeLink);
    await panel.click();
    await expect(hide).toBeVisible();
    await expect(page.getByLabel(m.mod_note, { exact: true })).toHaveValue("");
  } finally {
    fs.writeFileSync(clock, previous);
    await otherTab.close();
  }
});

test("an operator re-verifies before opening the shared invite form and can then create a link", async ({ page }) => {
  const handle = "reauth_invite_operator";
  const email = `${handle}@example.com`;
  const destination = "/invites/shared";
  const clock = path.join(state().dir, "server-clock.txt");
  const previous = fs.readFileSync(clock, "utf8");
  try {
    await useMember(page, email, "/invites/new");
    await waitForClientRoute(page);
    fs.writeFileSync(clock, String(25 * 3_600_000));
    const document = await page.request.get(`${destination}?lang=en`, { maxRedirects: 0 });
    expect(document.status()).toBe(302);
    expect(document.headers().location).toBe("/login?reauth=open-page&next=%2Finvites%2Fshared%3Flang%3Den");
    await page.getByRole("link", { name: m.shared_invites_title, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "open-page" && url.searchParams.get("next") === destination);
    await expect(page.getByText(formatMessage(m.reauth_for_open_page, { who: `@${handle}` }), { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: m.reauth_cancel, exact: true })).toHaveAttribute("href", "/");
    await verifyIdentity(page, email, "code");
    await expect(page).toHaveURL(destination);
    await waitForClientRoute(page);
    await expect(page.getByRole("status").filter({ hasText: m.reauth_action_pending })).toHaveCount(0);
    await page.getByLabel(m.shared_invites_label, { exact: true }).fill("Orchard open day");
    await page.getByRole("button", { name: m.shared_invites_create, exact: true }).click();
    await expect(page.getByRole("button", { name: m.invites_copy, exact: true })).toBeVisible();
    await expect(page).toHaveURL(destination);
  } finally {
    fs.writeFileSync(clock, previous);
  }
});
