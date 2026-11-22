import { expect, type CDPSession, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { enMessages, jaMessages, reverifyWithEmailCode, state, uiMessages, waitForHydration, type LoginCodeInbox } from "./helpers";

const authenticators = new WeakMap<Page, { client: CDPSession; authenticatorId: string }>();

// Chromium's real WebAuthn implementation signs the server challenge; the server verifier is never mocked.
export async function enableSigningAuthenticator(page: Page) {
  const previous = authenticators.get(page);
  if (previous) return previous;
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const current = { client, authenticatorId };
  authenticators.set(page, current);
  return current;
}

export async function installSeededSigningKey(page: Page, email: string) {
  const { client, authenticatorId } = await enableSigningAuthenticator(page);
  const credential = JSON.parse(fs.readFileSync(path.join(state().dir, "members", `${email}.webauthn.json`), "utf8"));
  await client.send("WebAuthn.addCredential", { authenticatorId, credential });
  return { client, authenticatorId };
}

async function reverifyForPasskeyAddition(page: Page, href: string, inbox?: LoginCodeInbox) {
  const reauth = new URL(href, page.url());
  const settings = new URL(reauth.searchParams.get("next")!, reauth);
  // Return to the same section without automatically enrolling an unnamed key.
  settings.searchParams.delete("passkey");
  reauth.searchParams.set("next", settings.pathname + settings.search + settings.hash);
  await page.goto(reauth.href);
  await waitForHydration(page);
  const messages = await uiMessages(page);
  await expect(page.getByRole("heading", { name: messages.reauth_title, exact: true })).toBeVisible();
  if (await page.getByRole("button", { name: messages.reauth_submit, exact: true }).isVisible()) {
    await reverifyWithEmailCode(page, inbox);
  } else {
    // Protected accounts use the existing passkey to reverify and to approve enrollment.
    await page.getByRole("button", { name: messages.login_passkey, exact: true }).click();
  }
  await expect(page).toHaveURL(settings.href);
  await waitForHydration(page);
}

export async function settingsPasskeyAddButton(page: Page, inbox?: LoginCodeInbox) {
  await waitForHydration(page);
  const messages = await uiMessages(page);
  const section = page.locator("#settings-passkeys");
  const label = { name: messages.settings_passkeys_add, exact: true };
  const add = section.getByRole("button", label);
  const reauth = section.getByRole("link", label);
  await expect(add.or(reauth)).toBeVisible();
  if (await reauth.isVisible()) await reverifyForPasskeyAddition(page, (await reauth.getAttribute("href"))!, inbox);
  await expect(add).toBeVisible();
  return add;
}

export async function addSettingsPasskey(page: Page, { name, inbox }: { name?: string; inbox?: LoginCodeInbox } = {}) {
  const add = await settingsPasskeyAddButton(page, inbox);
  const messages = await uiMessages(page);
  const section = page.locator("#settings-passkeys");
  const added = section.getByRole("status").filter({ hasText: messages.settings_passkeys_added });
  const alert = section.getByRole("alert");
  const reauth = page.getByRole("heading", { name: messages.reauth_title, exact: true });
  const click = async () => {
    if (name !== undefined) await section.getByLabel(messages.settings_passkeys_name_label, { exact: true }).fill(name);
    await add.click();
  };
  await click();
  // The session can also expire while the settings page is open.
  await expect(added.or(alert).or(reauth)).toBeVisible();
  if (await reauth.isVisible()) {
    await reverifyForPasskeyAddition(page, page.url(), inbox);
    await click();
  }
}

// Existing posting scenarios explicitly accept their own prepared text after opening the approval screen.
export async function acceptSignedWrite(page: Page) {
  await enableSigningAuthenticator(page);
  const messages = await page.locator("html").getAttribute("lang") === "ja" ? jaMessages : enMessages;
  const dialog = page.getByRole("dialog", { name: messages.signing_heading, exact: true });
  await expect(dialog).toBeVisible();
  const accept = dialog.getByRole("button", { name: new RegExp(`^(?:${[messages.signing_accept_post, messages.signing_accept_reply, messages.signing_accept_publish, messages.signing_accept_save, messages.signing_accept_remove].join("|")})$`) });
  await accept.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}
