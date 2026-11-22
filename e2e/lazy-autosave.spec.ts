import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as en, useMember, waitForFormReady } from "./helpers";
import { routeModule } from "./support/module-route";

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const form = (page: Page) => page.locator("form", { has: body(page) }).first();
const saved = (page: Page) => expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");

async function postReplyTarget(page: Page, text: string) {
  await waitForFormReady(form(page));
  await body(page).fill(text);
  await form(page).getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

for (const screen of ["new", "draft"]) test(`input and departure protection survive a delayed autosave module on the ${screen} screen`, async ({ page }) => {
  await useMember(page, `lazy_autosave_${screen}@example.com`, "/t/new");
  let id: string | undefined;
  if (screen === "draft") {
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await body(page).fill("The server's starting text");
    await saved(page);
    id = await page.locator('input[name="fromDraft"]').inputValue();
  }
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Promise<void>[] = [];
  const moduleRoute = await routeModule(page, "app/components/draft-autosave-content.tsx", route => {
    const request = held.then(() => route.continue());
    requests.push(request);
    return request;
  });
  const path = id ? `/drafts/${id}` : "/t/new";
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await waitForFormReady(form(page));
    await moduleRoute.assertHit();
    await expect(form(page)).not.toHaveAttribute("data-autosave", "ready");
    await body(page).fill("Writing before autosave is ready");
    expect(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
    const dialog = page.waitForEvent("dialog");
    await page.evaluate(() => {
      void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/drafts");
    });
    const shown = await dialog;
    expect(shown.message()).toBe(en.leave_unsaved_confirm);
    await shown.dismiss();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    release();
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await saved(page);
    await expect(body(page)).toHaveValue("Writing before autosave is ready");
    const linked = id ?? await page.locator('input[name="fromDraft"]').inputValue();
    expect(await (await page.request.get(`/drafts/${linked}`)).text()).toContain("Writing before autosave is ready");
    await page.reload();
    await expect(body(page)).toHaveValue("Writing before autosave is ready");
  } finally {
    release();
    await Promise.all(requests);
    await moduleRoute.dispose();
  }
});

test("a reply draft stays clean on opening and saves writing entered before autosave loads", async ({ page }) => {
  await useMember(page, "lazy_autosave_reply@example.com", "/t/new");
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  const ownerId = await page.evaluate(() => sessionStorage.getItem("tomola:draft-owner"));
  const headers = { Origin: new URL(page.url()).origin };
  const threadId = await postReplyTarget(page, "A thread for a reply draft");
  const response = await page.request.post("/drafts/ai-write", { headers, form: { ownerId: ownerId!, kind: "reply", threadId, body: "The saved reply", lang: "en" } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json() as { id: number };
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes++; });
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(form(page));
  await saved(page);
  await page.waitForTimeout(3000);
  expect(writes).toBe(0);
  expect(await (await page.request.get(`/drafts/autosave?draftId=${id}`)).json()).toEqual({ id, version: 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Promise<void>[] = [];
  const moduleRoute = await routeModule(page, "app/components/draft-autosave-content.tsx", route => {
    const request = held.then(() => route.continue());
    requests.push(request);
    return request;
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForFormReady(form(page));
    await moduleRoute.assertHit();
    await body(page).fill("A reply entered before autosave loads");
    release();
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await saved(page);
    expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("A reply entered before autosave loads");
  } finally {
    release();
    await Promise.all(requests);
    await moduleRoute.dispose();
  }
});

test("publishing waits for in-flight autosave and submits the latest fields", async ({ page }) => {
  await page.setExtraHTTPHeaders(clientHeaders("10.31.4.5"));
  await useMember(page, "lazy_autosave_publish_pending@example.com", "/settings");
  await page.goto("/t/new");
  await waitForFormReady(form(page));
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let stored = false;
  const isPublish = (request: import("@playwright/test").Request) =>
    request.method() === "POST" && new URL(request.url()).pathname.replace(/\.data$/, "") === "/t/new";
  let publications = 0;
  page.on("request", request => { if (isPublish(request)) publications++; });
  await page.route("**/drafts/autosave", async route => {
    const response = await route.fetch();
    stored = true;
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await body(page).fill("The first saved text");
    await expect.poll(() => stored).toBe(true);
    await body(page).fill("The latest text before publishing");
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    expect(publications).toBe(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const publishing = page.waitForRequest(isPublish);
    release();
    const submitted = new URLSearchParams((await publishing).postData() ?? "");
    expect(submitted.get("body")).toBe("The latest text before publishing");
    expect(submitted.get("fromDraft")).toMatch(/^\d+$/);
    await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
    await expect(page.locator(".longread").first()).toContainText("The latest text before publishing");
  } finally { release(); }
});

for (const kind of ["topic", "reply"]) test(`API ${kind} approval survives autosave connecting during review`, async ({ page }) => {
  await useMember(page, `lazy_autosave_review_${kind}@example.com`, "/settings/tokens");
  await page.getByLabel(en.tokens_name).fill("Delayed autosave approval");
  await page.getByRole("radio", { name: en.tokens_kind_draft }).check();
  await page.getByRole("button", { name: en.tokens_create }).click();
  const token = page.locator("[role=status] code");
  await expect(token).toHaveText(/^tml_draft_[A-Za-z0-9_-]{43}$/);
  const authorization = `Bearer ${(await token.innerText()).trim()}`;
  let target = "";
  if (kind === "reply") {
    await page.goto("/t/new");
    target = `reply_to: p-${await postReplyTarget(page, "A thread for delayed API approval")}\n`;
  }
  const text = `Reviewed API ${kind} writing`;
  const created = await page.request.post("/api/drafts", {
    headers: { Authorization: authorization, "Content-Type": "text/markdown" },
    data: `---\ntype: ${kind}\n${target}lang: en\n---\n${text}\n`,
  });
  expect(created.status()).toBe(201);
  const { approve_url } = await created.json() as { approve_url: string };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Promise<void>[] = [];
  const moduleRoute = await routeModule(page, "app/components/draft-autosave-content.tsx", route => {
    const request = held.then(() => route.continue());
    requests.push(request);
    return request;
  });
  try {
    await page.goto(approve_url, { waitUntil: "domcontentloaded" });
    await waitForFormReady(form(page));
    await moduleRoute.assertHit();
    await expect(form(page)).not.toHaveAttribute("data-autosave", "ready");
    const preview = page.waitForRequest(request => new URL(request.url()).pathname === "/signing");
    await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
    const checked = (await preview).postDataJSON().fields as [string, string][];
    const confirmation = page.getByRole("dialog", { name: en.signing_heading });
    await expect(confirmation.getByText(text, { exact: true })).toBeVisible();
    expect(new Map(checked).get("version")).toBe("1");
    release();
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    expect(await form(page).evaluate(element => [...new FormData(element as HTMLFormElement)])).toEqual(checked.filter(([name]) => name !== "intent"));
    await confirmation.getByRole("button", { name: en.confirm_publish, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+(?:[?#].*)?$/);
    await expect(page.locator(".longread").getByText(text, { exact: true })).toBeVisible();
  } finally {
    release();
    await Promise.all(requests);
    await moduleRoute.dispose();
  }
});
