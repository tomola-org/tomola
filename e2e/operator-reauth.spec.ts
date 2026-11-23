import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { confirmMagicLink, enMessages as m, formatMessage, loginCodeFor, logSize, magicLinkFor, state, useMember, waitForClientRoute } from "./helpers";

test("an operator returns to member search and to a post after re-verifying", async ({ page }) => {
  const email = "reauth_operator@example.com";
  const destination = "/admin/roles?q=reauth_target";
  const clock = path.join(state().dir, "server-clock.txt");
  const previous = fs.readFileSync(clock, "utf8");
  const topic: { id: number } = JSON.parse(fs.readFileSync(path.join(state().dir, "reauth-topic.json"), "utf8"));
  const otherTab = await page.context().newPage();
  const sessionCookie = async () => (await page.context().cookies()).find(cookie => cookie.name.endsWith("better-auth.session_token"))?.value;
  const verify = async (returnTo: string, method: "code" | "link") => {
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "moderation" && url.searchParams.get("next") === returnTo);
    await expect(page.getByText(formatMessage(m.reauth_for_moderation, { who: "@reauth_operator" }), { exact: true })).toBeVisible();
    const since = logSize();
    await page.getByRole("button", { name: m.reauth_submit, exact: true }).click();
    await expect(page.getByLabel(m.login_code_label, { exact: true })).toBeVisible();
    if (method === "link") await confirmMagicLink(page, await magicLinkFor(email, since));
    else {
      await page.getByLabel(m.login_code_label, { exact: true }).fill(await loginCodeFor(email, since));
      await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    }
    await expect(page).toHaveURL(returnTo);
    await waitForClientRoute(page);
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
    await verify(destination, "code");
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
    await verify(`${post}#p-${topic.id}`, "link");
    expect(await sessionCookie()).not.toBe(beforeLink);
    await panel.click();
    await expect(hide).toBeVisible();
    await expect(page.getByLabel(m.mod_note, { exact: true })).toHaveValue("");
  } finally {
    fs.writeFileSync(clock, previous);
    await otherTab.close();
  }
});
