import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";

export async function seedTranslationOnRead(db: Db, dir: string) {
  const fixtures: Record<string, { id: number; body: string }> = {};
  const names = ["member", "timeout", "public", "notice", "sourceNotice", "limited", "watch", "edited", "share", "navigate", "return", "inflight", "expired", "hidden"];
  // Each repeat that completes a real translation needs a fresh topic.
  const repeatedNames = new Set(["edited", "share", "navigate", "return"]);
  const count = Number(process.env.E2E_REPEAT_EACH ?? 1);
  const topics = names.flatMap(name => Array.from({ length: repeatedNames.has(name) ? count : 1 }, (_, index) => ({
    name, key: index ? `${name}_${index}` : name,
  })));
  for (const { name, key } of topics) {
    const [member] = await db.select().from(user).where(eq(user.email, `ondemand_${name === "sourceNotice" ? "notice" : name}@example.com`));
    const body = Array.from({ length: name === "member" ? 260 : 30 }, (_, n) => `段落 ${n + 1}。これは翻訳が完了するまで表示される、試験用の記事の原文です。（${key}）`).join("\n\n");
    const result = await createTopic(db, member.id, { lang: "ja", title: `訳を読む ${key}`, body }, { now: new Date("2025-11-01T00:00:00Z") });
    if (!result.ok) throw new Error(result.error);
    const [source] = await db.select().from(entries).where(eq(entries.id, result.id));
    await db.insert(translations).values({ entryId: result.id, lang: "fr", field: "title", kind: "primary", text: `Titre ${name}`, sourceHash: source.sourceHash, engine: "fake" });
    if (name === "notice" || name === "sourceNotice") {
      await db.insert(translations).values((["title", "body"] as const).map(field => ({ entryId: result.id, lang: "en", field, kind: "primary", text: `[en] ${field === "title" ? source.title : body}`, sourceHash: source.sourceHash, engine: "fake" })));
      const check = and(eq(jobs.kind, "check_source_language"), sql`${jobs.payload}->>'entryId' = ${String(result.id)}`);
      // Keep source confirmation independent of translation progress and worker timing.
      if (name === "notice") await db.update(jobs).set({ status: "done", payload: sql`${jobs.payload} || '{"checked":true}'::jsonb` }).where(check);
      else await db.update(jobs).set({ runAt: new Date("2100-01-01T00:00:00Z") }).where(check);
    }
    // The browser must be the first source of the body request. Other fixtures
    // and their jobs stay untouched.
    await db.delete(jobs).where(and(inArray(jobs.kind, ["translate_entry", "translate_title"]), sql`${jobs.payload}->>'entryId' = ${String(result.id)}`));
    fixtures[key] = { id: result.id, body };
  }
  fs.writeFileSync(path.join(dir, "translation-on-read.json"), JSON.stringify(fixtures));
}
