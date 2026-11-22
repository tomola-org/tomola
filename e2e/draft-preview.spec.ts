import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { saveEditorDraft } from "./draft-autosave-helper";
import { enMessages as en, formatMessage, messageTitleField, state, useMember, waitForFormReady } from "./helpers";
import { routeModule } from "./support/module-route";

const previewPath = /\/drafts\/\d+\/preview$/;
const previewButton = (page: Page) => page.getByRole("button", { name: en.preview, exact: true });
const bodySelector = 'textarea[name="body"]';
const bodyField = (page: Page) => page.locator(`main ${bodySelector}`);
const editorForm = (page: Page) => page.locator("main form", { has: page.locator(bodySelector) });
const publish = (page: Page) => page.getByRole("button", { name: en.draft_preview_publish, exact: true });

async function openEditor(page: Page, member: string) {
  await useMember(page, `${member}@example.com`, "/t/new");
  await waitForFormReady(editorForm(page));
}

test("opens and publishes a topic preview in the writing tab", async ({ page, context }) => {
  await openEditor(page, "preview_journey");
  await expect(previewButton(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: en.draft_preview_body, exact: true })).toBeVisible();
  const title = "A preview for the reading page";
  const text = "The same **article** will be published.";
  await messageTitleField(page).fill(title);
  await bodyField(page).fill(text);
  await previewButton(page).click();
  await expect(page).toHaveURL(previewPath);
  expect(context.pages()).toEqual([page]);
  await expect(page.getByText(en.draft_preview_banner, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator("[data-reading-body] strong")).toHaveText("article");
  await expect(page).toHaveTitle(formatMessage(en.draft_preview_title, { title }));
  const response = await page.request.get(page.url());
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(response.headers()["x-robots-tag"]).toBe("noindex");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  const missing = await page.request.get("/drafts/999999999/preview");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["cache-control"]).toBe("private, no-store");
  expect(missing.headers()["x-robots-tag"]).toBe("noindex");
  await expect(page.locator("#replies")).toHaveCount(0);
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.locator("[data-reading-byline] img")).toHaveCount(0);
  await expect(page.locator("[data-article-details] a")).toHaveCount(0);

  await page.getByRole("link", { name: en.draft_preview_back }).click();
  await expect(page).toHaveURL(/\/drafts\/\d+$/);
  await expect(bodyField(page)).toHaveValue(text);
  await bodyField(page).fill(`${text}\n\nA line added since opening the draft.`);
  await previewButton(page).click();
  await expect(page).toHaveURL(previewPath);
  await expect(page.getByText(en.signing_changes, { exact: true })).toHaveCount(0);
  await publish(page).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("offers the article preview only when the introduction mark is off", async ({ page }) => {
  await useMember(page, "preview_intro@example.com", "/t/new?intro=1");
  await waitForFormReady(editorForm(page));
  await bodyField(page).fill("My introduction");
  const intro = page.getByRole("checkbox", { name: en.intro_checkbox });
  await expect(intro).toBeChecked();
  await expect(previewButton(page)).toHaveCount(0);
  await intro.uncheck();
  await expect(previewButton(page)).toBeEnabled();
  await intro.check();
  await expect(previewButton(page)).toHaveCount(0);
});

test("shows the API draft comparison below the banner and keeps the editor when review cannot load", async ({ page }) => {
  await useMember(page, "preview_review@example.com", "/settings/tokens");
  await page.getByLabel(en.tokens_name).fill("Preview review");
  await page.getByRole("radio", { name: en.tokens_kind_draft }).check();
  await page.getByRole("button", { name: en.tokens_create }).click();
  const token = page.locator("[role=status] code");
  await expect(token).toHaveText(/^tml_draft_[A-Za-z0-9_-]{43}$/);
  const created = await page.request.post("/api/drafts", {
    headers: { Authorization: `Bearer ${(await token.innerText()).trim()}`, "Content-Type": "text/markdown" },
    data: "---\ntype: topic\ntitle: An API draft\nlang: en\n---\nThe API version.\n",
  });
  expect(created.status()).toBe(201);
  const { approve_url } = await created.json() as { approve_url: string };
  await page.goto(approve_url);
  const editor = editorForm(page);
  await waitForFormReady(editor);
  const body = "My review of the API version.";
  await bodyField(page).fill(body);
  await previewButton(page).click();
  await expect(page).toHaveURL(previewPath);
  const banner = page.getByRole("complementary", { name: en.draft_preview_banner });
  const comparison = page.getByText(en.signing_changes, { exact: true });
  await expect(comparison).toBeVisible();
  await expect(page.getByText(en.signing_client_warning, { exact: true })).toBeVisible();
  await expect(banner.getByText(en.signing_changes, { exact: true })).toHaveCount(0);
  await expect(banner.getByText(en.signing_client_warning, { exact: true })).toHaveCount(0);
  await expect(page.locator("main pre").last()).toHaveText(`+ ${body}`);

  await banner.getByRole("link", { name: en.draft_preview_back }).click();
  await waitForFormReady(editor);
  const module = await routeModule(page, "app/components/draft-confirmation-review.tsx", route => route.abort());
  try {
    await editor.getByRole("button", { name: en.draft_publish, exact: true }).click();
    await module.assertHit();
    await expect(page.getByRole("alert").filter({ hasText: en.signing_network_failed })).toBeVisible();
    await expect(page).toHaveURL(approve_url);
    await expect(bodyField(page)).toHaveValue(body);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(editor.getByRole("button", { name: en.draft_publish, exact: true })).toBeEnabled();
  } finally { await module.dispose(); }
});

test("reloads a stale article preview and resumes normal autosave after a preview save conflict", async ({ page, context }) => {
  await openEditor(page, "preview_conflict");
  await bodyField(page).fill("The draft initially in preview.");
  await previewButton(page).click();
  await expect(page).toHaveURL(previewPath);
  const editPath = new URL(page.url()).pathname.replace(/\/preview$/, "");
  const other = await context.newPage();
  const update = async (text: string) => {
    await other.goto(editPath);
    await waitForFormReady(editorForm(other));
    await bodyField(other).fill(text);
    await saveEditorDraft(other);
  };
  await update("The first update from another screen.");
  await publish(page).click();
  await expect(page.getByRole("alert").filter({ hasText: en.draft_preview_conflict })).toBeVisible();
  await expect(publish(page)).toBeDisabled();
  await page.reload();
  await expect(page.locator("[data-reading-body]")).toHaveText("The first update from another screen.");
  await expect(publish(page)).toBeEnabled();

  await page.getByRole("link", { name: en.draft_preview_back }).click();
  await waitForFormReady(editorForm(page));
  await expect(page.locator("form[data-autosave=ready]")).toHaveCount(1);
  await update("A second update from another screen.");
  const candidate = "My writing survives the preview conflict.";
  await bodyField(page).fill(candidate);
  const result = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${editPath}.data`);
  await previewButton(page).click();
  expect((await result).status()).toBe(409);
  await expect(page.getByRole("alert").filter({ hasText: en.draft_autosave_failed })).toBeVisible();
  await expect(bodyField(page)).toHaveValue(candidate);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("[data-draft-autosave]")).toContainText(en.draft_autosave_copied);
  await expect(bodyField(page)).toHaveValue(candidate);
});

test("reminds the author about an unpublished preview until publication", async ({ page }) => {
  await openEditor(page, "preview_reminder");
  const title = "A question left as a draft";
  await messageTitleField(page).fill(title);
  await bodyField(page).fill("What should we discuss next?");
  await page.getByText(en.asks_stance_checkbox, { exact: true }).click();
  await previewButton(page).click();
  await expect(page).toHaveURL(previewPath);
  const href = page.url();
  await expect(page.getByRole("button", { name: en.stance_agree, exact: true })).toBeDisabled();
  const memberMenu = page.locator("[data-member-menu-trigger]");
  const label = formatMessage(en.nav_drafts_previewed_count, { count: 1 });
  await expect(memberMenu).toHaveAccessibleName(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await memberMenu.click();
  const drafts = page.getByRole("menuitem", { name: new RegExp(en.nav_drafts) });
  await expect(drafts.getByLabel(label)).toBeVisible();
  await drafts.click();
  await expect(page).toHaveURL(/\/drafts$/);
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: title, exact: true }) });
  await expect(row).toContainText(en.draft_previewed);
  await page.goto(href);
  await publish(page).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  await memberMenu.click();
  await expect(drafts.getByLabel(label)).toHaveCount(0);
});

test("waits for the active autosave and then previews the latest input", async ({ page }) => {
  await openEditor(page, "preview_queued");
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/drafts/autosave", async route => {
    markStarted();
    await released;
    await route.continue();
  }, { times: 1 });
  await bodyField(page).fill("First saved copy.");
  await started;
  try {
    await bodyField(page).fill("The text typed during the active save.");
    await previewButton(page).click();
    await expect(page).toHaveURL(/\/t\/new$/);
  } finally { release(); }
  await expect(page).toHaveURL(previewPath);
  await expect(page.locator("[data-reading-body]")).toHaveText("The text typed during the active save.");
});

test("previews a native form without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: state().baseURL, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await useMember(page, "preview_native@example.com", "/t/new");
    await expect(previewButton(page)).toBeHidden();
    await bodyField(page).fill("A draft written in a native form.");
    await previewButton(page).click();
    await expect(page).toHaveURL(previewPath);
    await expect(page.locator("[data-reading-body]")).toHaveText("A draft written in a native form.");
  } finally { await context.close(); }
});

test("keeps the editor and candidate text when the preview request fails", async ({ page }) => {
  await openEditor(page, "preview_transport");
  const text = "A transport failure must leave this candidate in place.";
  await bodyField(page).fill(text);
  await page.route("**/t/new.data", route => route.abort("failed"), { times: 1 });
  await previewButton(page).click();
  await expect(page).toHaveURL(/\/t\/new$/);
  await expect(page.getByText(en.draft_autosave_failed, { exact: true })).toBeVisible();
  await expect(bodyField(page)).toHaveValue(text);
});
