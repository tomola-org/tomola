import { addSettingsPasskey } from "./signing-helper";
import { saveEditorDraft } from "./draft-autosave-helper";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, clientHeaders, enMessages, jaMessages, loginCodeFor, logSize, mailFor, state, waitForClientRoute, messageTitleField as titleField, waitForFormReady } from "./helpers";

test("a member without passkeys publishes browser drafts and exports unsigned posts", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.17.1.1") });
  const page = await context.newPage();
  try {
    await useMember(page, "enrollment@example.com");
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await page.getByRole("textbox", { name: enMessages.field_body, exact: true }).fill("My first post without a passkey");
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    await page.goto("/settings");
    if (!(await page.locator("#settings-advanced").evaluate(element => (element as HTMLDetailsElement).open))) await page.locator("#settings-advanced > summary").click();
    await expect(page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true })).not.toBeChecked();
    await expect(page.getByText(enMessages.settings_sign_posts_need_passkey, { exact: true })).toBeVisible();
    await page.locator("#settings-handle summary").click();
    await page.getByLabel(enMessages.onboarding_handle, { exact: true }).fill("new_enrollment");
    await page.getByRole("button", { name: enMessages.settings_handle_heading, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "handle" && url.hash === "#settings-handle");

    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await titleField(page).fill("Browser-authored draft");
    await page.getByLabel(enMessages.field_body).fill("Private browser text");
    await saveEditorDraft(page);
    await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
    await page.getByRole("button", { name: enMessages.draft_publish, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    const topicPath = new URL(page.url()).pathname;
    await page.goto(`${topicPath}/edit`);
    await page.getByLabel(enMessages.field_body).fill("Edited browser text");
    await page.getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await expect(page).toHaveURL(new URL(topicPath, state().baseURL).href);

    const exported = await (await context.request.get("/settings/export")).json();
    expect(exported.profile.sign_posts).toBe(false);
    expect(exported.signatures).toEqual([]);
  } finally { await context.close(); }
});


test("passkey-only sign-in rejects a pending email code and accepts a verified passkey", async ({ browser }) => {
  const m = jaMessages;
  const email = "login_methods_flow@example.com";
  const baseURL = state().baseURL;
  const member = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, locale: "ja", extraHTTPHeaders: clientHeaders("10.17.1.2") });
  const guest = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, locale: "ja", extraHTTPHeaders: clientHeaders("10.17.1.3") });
  try {
    const emailPage = await guest.newPage();
    await emailPage.goto("/login");
    await waitForClientRoute(emailPage);
    await emailPage.getByLabel(m.login_email, { exact: true }).fill(email);
    const since = logSize();
    await emailPage.getByRole("button", { name: m.login_submit, exact: true }).click();
    const pendingCode = await loginCodeFor(email, since);
    const codeField = emailPage.getByLabel(m.login_code_label, { exact: true });
    await expect(codeField).toBeVisible();

    const page = await member.newPage();
    await useMember(page, email, "/settings#settings-passkeys");
    await waitForClientRoute(page);
    const client = await member.newCDPSession(page);
    await client.send("WebAuthn.enable");
    const addAuthenticator = () => client.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
    const addKey = async (name: string) => {
      const list = page.locator("#settings-passkeys");
      await addSettingsPasskey(page, { name });
      await expect(list.getByText(name, { exact: true })).toBeVisible();
    };
    const first = await addAuthenticator();
    await addKey("予備の端末");
    await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first.authenticatorId });
    await addAuthenticator();
    await addKey("この端末");

    const setting = page.locator("#settings-login-methods");
    await setting.getByText(m.login_methods_review, { exact: true }).click();
    await expect(setting.getByRole("list")).toHaveCount(0);
    const linkNotice = setting.getByText(m.login_methods_ai_remains, { exact: true });
    const verifyPasskey = setting.getByRole("link", { name: m.login_methods_verify_passkey, exact: true });
    await expect(linkNotice).toBeVisible();
    expect((await linkNotice.boundingBox())!.y).toBeLessThan((await verifyPasskey.boundingBox())!.y);
    await verifyPasskey.click();
    await expect(page.getByRole("heading", { name: m.reauth_title, exact: true })).toBeVisible();
    await expect(page.getByText(m.reauth_for_enable_passkey_only.replace("{who}", "@login_methods_flow"), { exact: true })).toBeVisible();
    await waitForClientRoute(page);
    await page.getByRole("button", { name: m.login_passkey, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "#settings-login-methods");
    await waitForClientRoute(page);
    await setting.getByText(m.login_methods_review, { exact: true }).click();
    await setting.getByRole("button", { name: m.login_methods_enable, exact: true }).click();
    await expect(setting.getByRole("button", { name: m.login_methods_disable, exact: true })).toBeVisible();
    await expect(page.getByText(m.settings_passkeys_intro, { exact: true })).toHaveCount(0);
    expect((await member.request.post("/logout", { headers: { Origin: baseURL }, maxRedirects: 0 })).status()).toBe(302);

    await codeField.fill(pendingCode);
    await emailPage.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    await expect(emailPage.getByRole("alert").filter({ hasText: m.login_code_invalid })).toBeVisible();
    await expect(emailPage.locator("[data-member-menu-trigger]")).toHaveCount(0);
    await guest.clearCookies();
    await emailPage.goto("/login");
    await waitForClientRoute(emailPage);
    await emailPage.getByLabel(m.login_email, { exact: true }).fill(email);
    const beforeNotice = logSize();
    await emailPage.getByRole("button", { name: m.login_submit, exact: true }).click();
    await expect(emailPage.getByText(m.login_sent.replace("{email}", email), { exact: true })).toBeVisible();
    const notice = await mailFor(email, beforeNotice);
    expect(notice.text.trim()).toBe(m.mail_passkey_only_login);
    await expect(codeField).toBeVisible();

    await page.goto("/login");
    await waitForClientRoute(page);
    await page.getByRole("button", { name: m.login_passkey, exact: true }).click();
    await expect(page.locator('[data-member-menu-trigger][title="@login_methods_flow"]').first()).toBeVisible();
  } finally { await guest.close(); await member.close(); }
});
