import { expect } from "@playwright/test";
import { routeModule } from "./support/module-route";
import { test } from "./editor-fixture";
import { LANG_LABELS } from "../app/lib/languages";
import { clientHeaders, enMessages, messageTitleField, openUserMenu, uiMessages, useMember, waitForClientRoute, waitForFormReady } from "./helpers";

for (const locale of ["ja", "en", "fr"] as const) test(`public and member shells retain their labels after hydration and language selection in ${locale}`, async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const page = await context.newPage();
    const hydrationErrors: string[] = [];
    page.on("pageerror", error => hydrationErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && /hydration|hydrating|did not match|Minified React error/i.test(message.text())) hydrationErrors.push(message.text());
    });
    const response = await page.goto(`/why?lang=${locale}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const publicMessages = await uiMessages(page);
    expect(await response!.text()).toContain(publicMessages.footer_connect);
    await waitForClientRoute(page);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: publicMessages.footer_connect, exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: publicMessages.language_select, exact: true })).toBeVisible();

    await useMember(page, `trim_labels_${locale}@example.com`);
    await waitForClientRoute(page);
    const current = await uiMessages(page);
    const menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: current.nav_language, exact: true }).click();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("menuitemradio", { name: LANG_LABELS[locale], exact: true }).click(),
    ]);
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.reload();
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const messages = await uiMessages(page);
    await expect(page.getByRole("banner").locator('input[name="q"]')).toHaveAttribute("placeholder", messages.nav_search_placeholder);
    await page.setViewportSize({ width: 1280, height: 900 });
    let places = page.locator("[data-site-navigation]");
    if (await places.count() === 0) {
      const drawer = page.locator("[data-navigation-drawer]");
      await drawer.locator(":scope > summary").click();
      places = drawer.locator("nav");
    }
    await expect(places).toHaveAccessibleName(messages.nav_side_label);
    await expect(places.getByRole("link", { name: messages.nav_home, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByRole("link", { name: messages.nav_glossary, exact: true })).toBeVisible();

    // Public document HTML remains unpersonalized; its later member header
    // must still use the document's server-selected language.
    await page.goto("/why");
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("[data-member-menu-trigger]")).toBeVisible();
    await expect(page.getByRole("banner").getByRole("link", { name: messages.nav_new_topic, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByRole("link", { name: messages.footer_connect, exact: true })).toBeVisible();
    expect(hydrationErrors).toEqual([]);
  } finally { await context.close(); }
});
