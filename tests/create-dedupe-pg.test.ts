import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { withMemberWrite } from "~/lib/signing.server";
import { addMember } from "./helpers/db";
import { holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("recent submissions on PostgreSQL", { tags: ["postgres"] }, () => {
  const writer = "repeat_writer";
  let scratch: ScratchDb;
  let db: Db;
  let secondDb: Db;
  let thread: number;
  beforeAll(async () => {
    scratch = await createScratchDb();
    [db, secondDb] = await Promise.all([scratch.open("repeat-first"), scratch.open("repeat-second")]);
    await addMember(db, writer, writer);
    const topic = await createTopic(db, writer, { body: "A discussion for replies.", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    thread = topic.id;
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); }, 60_000);

  it.each(["topic", "reply"] as const)("concurrent %s submissions return one entry", async kind => {
    const input = { lang: "en", body: `Concurrent ${kind} writing.` };
    const form = new FormData();
    form.set("body", input.body);
    form.set("lang", input.lang);
    const request = new Request(kind === "topic" ? "http://localhost/t/new" : `http://localhost/t/${thread}`, { method: "POST", body: form });
    const opts = { beforeNewSubmission: async () => null };
    const submit = (connection: Db) => withMemberWrite(connection, writer, request, form, tx =>
      kind === "topic" ? createTopic(tx, writer, input, opts) : createReply(tx, writer, thread, input, opts));

    const first = holdTx(db, submit);
    let second: ReturnType<typeof submit> | undefined;
    try {
      const created = await first.ready;
      expect(created).toMatchObject({ ok: true });
      second = submit(secondDb);
      const admin = await scratch.admin();
      try {
        await waitForLockWait(admin, "repeat-second");
      } finally {
        await admin.end();
      }
      await first.commit();
      expect(await second).toEqual({ ...created, reused: true });
      if (!created.ok) throw new Error(created.error);
      expect(await db.select({ id: entries.id }).from(entries).where(and(eq(entries.authorId, writer), eq(entries.kind, kind), eq(entries.body, input.body))))
        .toEqual([{ id: created.id }]);
    } finally {
      await first.rollback();
      await second?.catch(() => {});
    }
  }, 30_000);
});
