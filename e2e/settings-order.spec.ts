import { openTranslationSettings } from "./helpers";
import { LANG_LABELS } from "../app/lib/languages";
import { expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, useMember, waitForClientRoute, clientHeaders, enMessages as en, formatMessage } from "./helpers";

test.describe.configure({ mode: "serial" });
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.26.63.1") });
  page = await context.newPage();
  await useMember(page, "settings_order@example.com");
});
test.afterAll(() => context?.close());

for (const width of [1280, 390]) {
  test(`everyday settings stay visible and advanced tools open through the contents at width ${width}`, async ({}, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings");
    await waitForClientRoute(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const contents = page.getByRole("navigation", { name: en.settings_title, exact: true });
    const advanced = page.locator("#settings-advanced");
    const languages = page.getByRole("region", { name: en.settings_langs_heading, exact: true });
    await expect(page.locator("#settings-display-lang")).not.toBeVisible();
    await openTranslationSettings(page);
    await expect(languages.getByRole("combobox", { name: en.display_lang_label, exact: true })).toBeVisible();
    await expect(languages.getByText(formatMessage(en.settings_display_effect, { lang: LANG_LABELS.en }), { exact: true })).toBeVisible();
    const profile = page.getByRole("region", { name: en.settings_profile_heading, exact: true });
    const handle = profile.getByRole("region", { name: en.settings_handle_heading, exact: true });
    await expect(handle.getByText("@settings_order", { exact: true })).toBeVisible();
    await expect(handle.getByLabel(en.onboarding_handle, { exact: true })).toBeHidden();
    await handle.locator("summary").click();
    await expect(handle.getByLabel(en.onboarding_handle, { exact: true })).toBeVisible();
    await handle.locator("summary").click();
    const records = page.getByRole("region", { name: en.settings_records_heading, exact: true });
    for (const name of [en.settings_media_title, en.settings_stances_link, en.settings_export_link]) await expect(records.getByRole("link", { name, exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(advanced).not.toHaveAttribute("open");
    await expect(page.getByRole("heading", { name: en.settings_ai_heading, exact: true })).toBeVisible();
    await expect(contents.locator('a[href="#settings-advanced"]')).toHaveCount(1);
    await expect(contents.locator('a[href="#settings-links"], a[href="#settings-share"], a[href="#settings-export"]')).toHaveCount(0);
    await expect(contents).toBeInViewport({ ratio: 1 });
    const early = [en.settings_langs_heading, en.settings_email_heading, en.settings_profile_heading];
    const later = [en.settings_login_heading, en.settings_sessions_heading, en.settings_share_heading];
    for (const first of early) {
      for (const second of later) {
        const firstSection = page.getByRole("region", { name: first, exact: true });
        const secondId = await page.getByRole("region", { name: second, exact: true, includeHidden: true }).getAttribute("id");
        expect(await firstSection.evaluate((element, id) => Boolean(element.compareDocumentPosition(document.getElementById(id!)!) & Node.DOCUMENT_POSITION_FOLLOWING), secondId)).toBe(true);
      }
    }
    for (const link of await contents.getByRole("link").all()) {
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^#.+/);
      const target = page.locator(href!);
      await expect(target).toHaveCount(1);
      const label = href === "#settings-advanced" ? target.locator(":scope > summary") : target.getByRole("heading").first();
      await expect(label).toHaveText((await link.innerText()).trim());
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await expect(label).toBeInViewport();
    }
    expect(await page.locator("main section").evaluateAll(elements => elements.every(element => element.id.length > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/settings");
    await captureScreenshot(page, { path: testInfo.outputPath(`settings-${width}.png`), fullPage: true }, "e2e-settings-order");
    await page.locator("#settings-advanced > summary").click();
    await expect(advanced.getByRole("heading", { level: 2, name: en.settings_advanced_heading, exact: true })).toBeVisible();
    for (const name of [en.settings_automation_heading, en.settings_share_heading]) await expect(advanced.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
    const share = page.locator("#settings-share");
    await expect(share.getByRole("button", { name: en.settings_share_copy, exact: true })).toBeVisible();
    await expect(share.getByRole("textbox")).toBeHidden();
    await share.getByText(en.settings_share_show, { exact: true }).click();
    await expect(share.getByRole("textbox")).toBeVisible();
    await expect(page.getByRole("heading", { name: en.settings_ai_heading, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureScreenshot(page, { path: testInfo.outputPath(`settings-advanced-${width}.png`), fullPage: true }, "e2e-settings-order");
  });
}

test("an invalid handle remains at its section with the error in view", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await waitForClientRoute(page);
  const handle = page.getByRole("region", { name: en.settings_handle_heading, exact: true });
  await handle.locator("summary").click();
  await handle.getByLabel(en.onboarding_handle, { exact: true }).fill("invalid!handle");
  await handle.getByRole("button", { name: en.settings_handle_heading, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "#settings-handle");
  await expect(handle.getByRole("alert")).toHaveText(en.onboarding_error_handle);
  await expect(handle.getByRole("alert")).toBeInViewport({ ratio: 1 });
  await expect(handle.getByLabel(en.onboarding_handle, { exact: true })).toHaveValue("invalid!handle");
});

test("credential revocation describes retained sign-in methods and links to passkey settings", async () => {
  await page.goto("/settings#settings-login-methods");
  await waitForClientRoute(page);
  const login = page.locator("#settings-login-methods");
  await login.getByText(en.login_methods_compromise, { exact: true }).click();
  await expect(login.getByText(en.login_methods_revoke_pending, { exact: true })).toBeVisible();
  await expect(login.getByText(en.login_methods_revoke_keep, { exact: true })).toBeVisible();
  await login.getByRole("link", { name: en.settings_passkeys_heading, exact: true }).click();
  await expect(page).toHaveURL(url => url.hash === "#settings-passkeys");
  await expect(page.locator("#settings-passkeys-heading")).toBeInViewport();
});

test("advanced section fragments open on arrival and after hash changes", async () => {
  for (const id of ["settings-tokens", "settings-share"]) {
    await page.goto(`/settings#${id}`);
    await waitForClientRoute(page);
    await expect(page.locator("#settings-advanced")).toHaveAttribute("open");
    await expect(page.locator(`#${id}`)).toBeInViewport();
    await expect(page.getByRole("navigation", { name: en.settings_title, exact: true }).getByRole("link", { name: en.settings_advanced_heading, exact: true })).toHaveAttribute("aria-current", "location");
  }
  // Change the hash without native fragment navigation to exercise the JavaScript fallback.
  await page.evaluate(() => {
    (document.getElementById("settings-advanced") as HTMLDetailsElement).open = false;
    history.replaceState(null, "", "#settings-share");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await expect(page.locator("#settings-advanced")).toHaveAttribute("open");
  await expect(page.locator("#settings-share")).toBeInViewport();
});

test("AI-link revocation opens its own disclosure", async ({ browser }) => {
  const native = await browser.newContext({
    locale: "en-US", javaScriptEnabled: true,
    storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("10.26.63.3"),
  });
  try {
    const nativePage = await native.newPage();
    await nativePage.goto("/settings");
    await expect(nativePage.locator("#settings-advanced")).not.toHaveAttribute("open");
    await nativePage.locator("#settings-links > summary").click();
    await nativePage.getByRole("button", { name: en.settings_ai_links_revoke, exact: true }).click();
    await expect(nativePage).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "ai-links" && url.hash === "#settings-links");
    await expect(nativePage.locator("#settings-links")).toHaveAttribute("open");
    await expect(nativePage.locator("#settings-links").getByRole("status")).toBeInViewport();
    await nativePage.goto("/settings#settings-share");
    await waitForClientRoute(nativePage);
    await expect(nativePage.locator("#settings-advanced > summary")).toBeVisible();
  } finally {
    await native.close();
  }
});
