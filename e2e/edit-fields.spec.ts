import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { MEMBER_RATE_LIMITS } from "../app/lib/rate-limit.server";
import { test } from "./editor-fixture";
import { enMessages as en, state, titleField, useMember, waitForFormReady, waitForHydration } from "./helpers";
import { beforeHydration } from "./support/prehydration";

const origin = () => ({ Origin: state().baseURL });
const bodyField = (page: Page) => page.locator('textarea[name="body"]');
const editor = (page: Page) => page.locator("form", { has: bodyField(page) });

async function createTopic(page: Page, asksStance = false) {
  const res = await page.request.post("/t/new", {
    headers: origin(), form: { title: "Original heading", body: "Original text.", lang: "en", asksStance: asksStance ? "1" : "0" }, maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
  return new URL(res.headers().location, state().baseURL).pathname;
}

async function createReply(page: Page, topicPath: string) {
  const res = await page.request.post(topicPath, { headers: origin(), form: { body: "Original reply.", lang: "en" }, maxRedirects: 0 });
  expect(res.status()).toBe(302);
  return `/c/${/#c-(\d+)/.exec(res.headers().location)![1]}/edit`;
}

async function save(page: Page, path: string) {
  const response = page.waitForResponse(res => res.request().method() === "POST" && [path, `${path}.data`].includes(new URL(res.url()).pathname));
  await page.getByRole("button", { name: en.save_changes, exact: true }).click();
  return response;
}

test("the topic editor keeps text entered before hydration", async ({ page }) => {
  await useMember(page, "edit_fields_early@example.com", "/t/new");
  const path = `${await createTopic(page)}/edit`;
  await beforeHydration(page, path, async () => {
    await expect(bodyField(page)).toHaveValue("Original text.");
    await titleField(page).fill("Revised heading");
    await bodyField(page).fill("Original text. An early addition.");
  }, () => waitForHydration(page));
  await waitForFormReady(editor(page));
  await expect(titleField(page)).toHaveValue("Revised heading");
  await expect(bodyField(page)).toHaveValue("Original text. An early addition.");
  await Promise.all([
    page.waitForEvent("dialog").then(async dialog => {
      await dialog.dismiss();
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toBe(en.leave_unsaved_confirm);
    }),
    page.getByRole("link", { name: en.cancel, exact: true }).click(),
  ]);
  await expect(page).toHaveURL(new URL(path, state().baseURL).href);
});

test("the reply editor keeps text entered before hydration", async ({ page }) => {
  await useMember(page, "edit_fields_early_reply@example.com", "/t/new");
  const path = await createReply(page, await createTopic(page));
  await beforeHydration(page, path, async () => {
    await expect(bodyField(page)).toHaveValue("Original reply.");
    await bodyField(page).fill("");
  }, () => waitForHydration(page));
  await waitForFormReady(editor(page));
  await expect(bodyField(page)).toHaveValue("");
});

test("a prefilled new topic keeps text entered before hydration", async ({ page }) => {
  await useMember(page, "edit_fields_early_new@example.com");
  const source = new URLSearchParams({ title: "Shared page", url: "https://example.invalid/reading" });
  const prefill = "[Shared page](https://example.invalid/reading)\n\n";
  const body = `${prefill}My notes on the reading.`;
  await beforeHydration(page, `/t/new?${source}`, async () => {
    await expect(bodyField(page)).toHaveValue(prefill);
    await bodyField(page).fill(body);
  }, () => waitForHydration(page));
  await waitForFormReady(editor(page));
  await expect(bodyField(page)).toHaveValue(body);
});

test("returned multiline AI material keeps text entered before hydration", async ({ page }) => {
  await useMember(page, "edit_fields_early_material@example.com", "/t/new");
  await waitForFormReady(editor(page));
  const material = page.locator('textarea[name="aiMaterial"]');
  const submitted = "First source.\nSecond source.";
  const revised = `${submitted}\nThird source.`;
  await page.locator("details", { has: material }).locator("summary").click();
  await material.fill(submitted);

  await beforeHydration(page, async () => {
    const [response] = await Promise.all([
      page.waitForResponse(res => res.request().isNavigationRequest() && res.request().method() === "POST"),
      page.waitForEvent("framenavigated", frame => frame === page.mainFrame()),
      editor(page).evaluate(form => (form as HTMLFormElement).submit()),
    ]);
    expect(response.status()).toBe(400);
  }, async () => {
    await expect(material).toHaveValue(submitted);
    await material.fill(revised);
  }, () => waitForHydration(page));
  await expect(material).toHaveValue(revised);
});

for (const kind of ["topic", "reply"] as const) {
  test(`${kind} edit keeps submitted values when the edit allowance is reached`, async ({ page }, info) => {
    await useMember(page, `edit_fields_${kind}_limit@example.com`, "/t/new");
    const topicPath = await createTopic(page);
    const path = kind === "topic" ? `${topicPath}/edit` : await createReply(page, topicPath);
    await page.goto(path);
    await waitForFormReady(editor(page));
    if (kind === "topic") await titleField(page).fill("Retained heading");
    await bodyField(page).fill("Retained edit.");
    const clock = join(state().dir, "server-clock.txt");
    const previous = readFileSync(clock, "utf8");
    const { limit, windowSeconds } = MEMBER_RATE_LIMITS.edit;
    const windowMs = windowSeconds * 1000;
    const untilReset = windowMs - (Date.now() + Number(previous)) % windowMs;
    // Give the allowance setup and the browser submission the same window.
    const nearReset = untilReset <= info.timeout;
    if (nearReset) writeFileSync(clock, String(Number(previous) + untilReset + 1000));
    try {
      const headers = origin();
      for (let attempt = 0; attempt < limit; attempt++) {
        const response = await page.request.post(path, { headers, form: { body: "" }, maxRedirects: 0 });
        const status = response.status();
        await response.dispose();
        if (status === 429) break;
        expect(status).toBe(400);
      }
      const res = await save(page, path);
      expect(res.status()).toBe(429);
      expect(Number(res.headers()["retry-after"])).toBeGreaterThan(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(kind === "topic" ? en.edit_topic_title : en.edit_reply_title);
      await expect(page.getByRole("alert")).toContainText(en.error_rate_limited);
      await expect(bodyField(page)).toHaveValue("Retained edit.");
      if (kind === "topic") await expect(titleField(page)).toHaveValue("Retained heading");
    } finally {
      if (nearReset) writeFileSync(clock, previous);
    }
  });
}

for (const scenario of ["lock", "native"] as const) {
  test(`a locked question shows the submitted edit in the ${scenario === "native" ? "document" : "client"} response`, async ({ browser }) => {
    const native = scenario === "native";
    const authorContext = await browser.newContext({ javaScriptEnabled: !native });
    const voterContext = await browser.newContext();
    try {
      const page = await authorContext.newPage();
      const voter = await voterContext.newPage();
      await useMember(page, `edit_fields_${scenario}@example.com`, "/t/new");
      const topicPath = await createTopic(page, true);
      const otherPath = native ? null : await createTopic(page);
      const path = `${topicPath}/edit`;
      await page.goto(path);
      if (!native) await waitForFormReady(editor(page));
      await titleField(page).fill("My revised question");
      const revisedBody = "My revised text.\n\nThe second paragraph.";
      await bodyField(page).fill(revisedBody);
      const deviceCopy = () => page.evaluate(suffix => Object.entries(localStorage).find(([key]) => key.startsWith("tomola:draft:") && key.endsWith(suffix))?.[1], `:edit:topic:${topicPath.split("/").at(-1)}`);
      if (!native) await expect.poll(deviceCopy).toContain("My revised text.");

      await useMember(voter, `edit_fields_${scenario}_voter@example.com`, topicPath);
      await waitForHydration(voter);
      const agree = voter.locator("#stance").getByRole("button", { name: en.stance_agree, exact: true });
      await agree.click();
      await expect(agree).toHaveAttribute("aria-pressed", "true");

      const res = await save(page, path);
      expect(res.status()).toBe(409);
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      await expect(page).toHaveURL(new URL(path, state().baseURL).href);
      await expect(page.getByRole("heading", { name: en.edit_locked_title })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText(en.edit_locked_body);
      await expect(page.getByRole("heading", { name: en.edit_locked_unsaved })).toBeVisible();
      await expect(page.getByText("My revised question", { exact: true })).toBeVisible();
      const submittedBody = page.getByRole("textbox", { name: en.edit_locked_unsaved });
      await expect(submittedBody).toHaveValue(revisedBody);
      await expect(submittedBody).toHaveJSProperty("readOnly", true);
      if (!native) {
        await submittedBody.focus();
        const selection = await submittedBody.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]);
        expect(selection).toEqual([0, revisedBody.length]);
      }
      await expect(page.getByRole("link", { name: en.edit_locked_reply, exact: true })).toHaveAttribute("href", `${topicPath}#reply`);
      await expect(page.getByRole("link", { name: en.objections_new_alt, exact: true })).toHaveAttribute("href", `/t/new?asks_stance=1&alt_of=${topicPath.split("/").at(-1)}`);
      if (otherPath) {
        await expect.poll(deviceCopy).toContain("My revised text.");
        await page.goto(`${otherPath}/edit`);
        await expect(bodyField(page)).toHaveValue("Original text.");
        await waitForFormReady(editor(page));
        await expect(bodyField(page)).toHaveValue("Original text.");
      }
    } finally {
      await voterContext.close();
      await authorContext.close();
    }
  });
}
