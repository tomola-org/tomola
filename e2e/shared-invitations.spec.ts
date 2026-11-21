import { expect, test, type Page } from "@playwright/test";
import { completeTrialFields, formatMessage, hostCookieName, loginCodeFor, logSize, magicLinkFor, state, uiMessages, useMember, waitForClientRoute } from "./helpers";

async function sendCode(page: Page, email: string, mailTo = email) {
  const m = await uiMessages(page);
  await waitForClientRoute(page);
  await page.getByLabel(m.login_email, { exact: true }).fill(email);
  const start = logSize();
  const response = page.waitForResponse(response => response.request().method() === "POST");
  await page.getByRole("button", { name: m.invite_submit, exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("heading", { name: m.login_code_heading, exact: true })).toBeVisible();
  await expect(page.getByText(formatMessage(m.invite_sent, { email }), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: m.login_resend, exact: true })).toBeVisible();
  return { start, code: await loginCodeFor(mailTo, start) };
}

async function enterCode(page: Page, code: string) {
  const m = await uiMessages(page);
  await page.getByLabel(m.login_code_label, { exact: true }).fill(code);
  await page.getByRole("button", { name: m.invite_code_submit, exact: true }).click();
}

async function finishProfile(page: Page, handle: string) {
  await expect(page).toHaveURL(/\/onboarding$/);
  const m = await uiMessages(page);
  await page.getByLabel(m.onboarding_handle, { exact: true }).fill(handle);
  await completeTrialFields(page);
  await page.getByRole("button", { name: m.onboarding_join, exact: true }).click();
}

test("an operator shares capped links, enrollment stays bound across tabs, and closed links permit only existing sign-ins", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await useMember(page, "shared_link_operator@example.com", "/invites/new");
  const m = await uiMessages(page);
  const headers = (await page.request.get("/invites/new")).headers();
  expect(headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" });

  async function createLink(label: string, village: string) {
    await waitForClientRoute(page);
    const form = page.locator("form").filter({ has: page.locator('input[value="create-shared"]') });
    await form.getByLabel(m.shared_invites_label, { exact: true }).fill(label);
    await form.getByLabel(m.shared_invites_max_uses, { exact: true }).fill("2");
    const select = form.getByRole("combobox", { name: m.invites_village, exact: true });
    await expect(select).toBeVisible();
    await select.selectOption({ label: village });
    const response = page.waitForResponse(response => response.request().method() === "POST");
    await form.getByRole("button", { name: m.shared_invites_create, exact: true }).click();
    expect((await response).headers()["cache-control"]).toContain("no-store");
    const link = page.locator("code").filter({ hasText: "/invite/" });
    await expect(link).toBeVisible();
    await expect(form.getByLabel(m.shared_invites_label, { exact: true })).toHaveValue("");
    await expect(form.getByLabel(m.shared_invites_max_uses, { exact: true })).toHaveValue("20");
    const url = (await link.textContent())!;
    await page.reload();
    await expect(link).toHaveCount(0);
    return url;
  }

  const linkA = await createLink("Workshop A", "Shared entry A");
  const linkB = await createLink("Workshop B", "Shared entry B");
  await page.goto("/admin/invitations");
  const rowA = page.getByRole("row", { name: /Workshop A/ });
  const rowB = page.getByRole("row", { name: /Workshop B/ });
  await expect(rowA).toContainText("0 / 2");
  await expect(rowA).toContainText("@shared_link_operator");
  await expect(rowB).toContainText("Shared entry B");

  const contexts = await Promise.all(Array.from({ length: 6 }, () => browser.newContext({ baseURL: state().baseURL, locale: "ja-JP" })));
  try {
    const [guest, second, stale, mail, existing, held] = await Promise.all(contexts.map(context => context.newPage()));
    await guest.goto(linkA);
    const ja = await uiMessages(guest);
    await expect(guest.getByRole("heading", { name: formatMessage(ja.invite_title_from, { handle: "shared_link_operator" }), exact: true })).toBeVisible();
    await expect(guest.getByText("Workshop A")).toHaveCount(0);
    const email = "shared_link_guest@example.com";
    await sendCode(guest, email);

    const otherTab = await contexts[0].newPage();
    await otherTab.goto(linkB);
    await expect(otherTab.getByLabel(ja.login_email, { exact: true })).toBeVisible();
    const cookie = async () => (await contexts[0].cookies()).find(c => c.name === hostCookieName("tomola.invitation"))?.value;
    const cookieB = await cookie();
    expect(cookieB).toMatch(/^s:/);
    const start = logSize();
    await guest.getByRole("button", { name: ja.login_resend, exact: true }).click();
    await expect(guest.getByText(ja.login_resent, { exact: true })).toBeVisible();
    expect(await cookie()).toBe(cookieB);
    await enterCode(guest, await loginCodeFor(email, start));
    await finishProfile(guest, "shared_link_guest");
    await expect(guest).toHaveURL(/\/v\/shared-entry-a$/);
    expect(await cookie()).toBe(cookieB);

    await Promise.all([stale, mail, existing, second].map(client => client.goto(linkA)));
    await held.goto(linkB);
    const staleCode = (await sendCode(stale, "shared_link_stale@example.com")).code;
    const mailStart = (await sendCode(mail, "shared_link_confirmation@example.com")).start;
    const existingCode = (await sendCode(existing, "shared_link_existing@example.com")).code;
    await sendCode(held, "shared_link_held@example.com", "decoy@example.invalid");
    const resent = logSize();
    await held.getByRole("button", { name: ja.login_resend, exact: true }).click();
    await expect(held.getByText(ja.login_resent, { exact: true })).toBeVisible();
    await loginCodeFor("decoy@example.invalid", resent);
    await enterCode(second, (await sendCode(second, "shared_link_second@example.com")).code);
    await finishProfile(second, "shared_link_second");
    await expect(second).toHaveURL(/\/v\/shared-entry-a$/);

    await page.reload();
    await expect(rowA).toContainText("2 / 2");
    await expect(rowB).toContainText("0 / 2");
    await otherTab.goto(linkA);
    await expect(otherTab.getByText(formatMessage(ja.shared_invite_signed_in, { handle: "shared_link_guest" }), { exact: true })).toBeVisible();
    await expect(otherTab.getByRole("link", { name: ja.confirm_home, exact: true })).toBeVisible();
    await expect(otherTab.getByLabel(ja.login_email, { exact: true })).toHaveCount(0);
    expect(await cookie()).toBe(cookieB);

    await expect(rowA).toContainText(m.shared_invites_status_full);
    await rowB.getByRole("button", { name: m.invites_revoke, exact: true }).click();
    await expect(rowB).toContainText(m.invites_revoked);

    await enterCode(stale, staleCode);
    await expect(stale.getByRole("heading", { name: ja.shared_invite_unavailable, exact: true })).toBeVisible();
    await expect(stale.getByRole("button", { name: ja.login_resend, exact: true })).toHaveCount(0);
    await stale.goto(linkA);
    await expect(stale.getByRole("heading", { name: ja.shared_invite_full, exact: true })).toBeVisible();

    await mail.goto(await magicLinkFor("shared_link_confirmation@example.com", mailStart));
    await waitForClientRoute(mail);
    await mail.locator('main form button[type="submit"]').click();
    await expect(mail.getByRole("heading", { name: ja.shared_invite_unavailable, exact: true })).toBeVisible();
    await expect(mail.getByRole("link", { name: ja.invite_invalid_login, exact: true })).toBeVisible();
    await mail.goto(linkB);
    await expect(mail.getByText(ja.invite_invalid, { exact: true })).toBeVisible();

    await enterCode(existing, existingCode);
    await expect(existing).toHaveURL(/\/$/);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
