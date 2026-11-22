import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { drafts, profiles } from "../app/lib/db/schema";
import { createDraft } from "../app/lib/drafts.server";
import { createReply, createTopic } from "../app/lib/entries.server";
import { confirmationForDraftPreview } from "../app/lib/signing.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { postingVillages, villageSlug } from "../app/lib/villages.server";
import { AI_CONFIRMATION_CASES } from "./member-fixtures";

export async function seedDraftConfirmations(db: Db, dir: string) {
  const owner = async (handle: string) => {
    const [profile] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, handle));
    return profile.id;
  };
  const scenarios = [];
  for (const scenario of AI_CONFIRMATION_CASES) {
    const author = await owner(`ai_confirm_${scenario}`);
    const body = `AI draft for ${scenario} confirmation.`;
    const draft = await createDraft(db, author, { kind: "topic", body, lang: "en" }, { via: "api" });
    if (!draft.ok) throw new Error(draft.error);
    let expiredConfirmation: string | undefined;
    if (scenario === "expired") {
      const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
      const posting = villagesEnabled() ? await postingVillages(db, author, await villageSlug(db, row.villageId), { repair: false }) : null;
      expiredConfirmation = await confirmationForDraftPreview(db, row, posting, 0);
      if (!expiredConfirmation) throw new Error("Expired confirmation fixture could not be prepared");
    }
    scenarios.push([scenario, { id: draft.id, body, expiredConfirmation }]);
  }
  fs.writeFileSync(path.join(dir, "draft-confirmations.json"), JSON.stringify(Object.fromEntries(scenarios)));

  const now = new Date("2025-01-01T00:00:00Z");
  const topic = await createTopic(db, await owner("edit_version_topic_signed"), { title: "Version A", body: "Body A", lang: "en" }, { now });
  const question = await createTopic(db, await owner("edit_version_reply_signed"), { title: "Version A", body: "Body A", lang: "en", asksStance: true }, { now });
  if (!topic.ok || !question.ok) throw new Error("Signed edit target seed failed");
  const reply = await createReply(db, await owner("edit_version_reply_signed"), question.id, { body: "Body A", lang: "en", stanceTag: "agree" }, { now });
  if (!reply.ok) throw new Error(reply.error);
  fs.writeFileSync(path.join(dir, "signed-edit-targets.json"), JSON.stringify({ topic: `/t/${topic.id}/edit`, reply: `/c/${reply.id}/edit` }));
}
