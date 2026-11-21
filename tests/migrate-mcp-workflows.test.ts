import fs from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";
import { migrateDatabase } from "~/lib/db/migrate.server";
import { migrationsBefore } from "./helpers/migrations";
import { createScratchDb, REAL_PG_URL } from "./helpers/pg-real";

it.skipIf(!REAL_PG_URL)("preserves posts and reading counts and backfills only owned API draft receipts on upgrade", { tags: ["postgres"], timeout: 60_000 }, async () => {
  const scratch = await createScratchDb({ migrate: false });
  const previous = migrationsBefore("mcp_post_workflows");
  try {
    const client = await scratch.admin();
    await migrate(drizzle(client), { migrationsFolder: previous });
    await client.query(`INSERT INTO "user" (id, name, email)
      VALUES ('upgrade-author', 'Upgrade fixture', 'upgrade@example.invalid')`);
    const { rows: [entry] } = await client.query<{ id: string }>(`INSERT INTO entries (kind, author_id, lang, title, body)
      VALUES ('topic', 'upgrade-author', 'en', 'Existing topic', 'Existing article body') RETURNING id`);
    await client.query(`INSERT INTO entry_reading_counts (entry_id, day, method, is_translated, count)
      VALUES ($1, '2026-01-01', 'browser', false, 12)`, [entry.id]);
    const { rows: [token] } = await client.query<{ id: string }>(`INSERT INTO api_tokens (user_id, name, kind, token_hash)
      VALUES ('upgrade-author', 'Legacy token fixture', 'draft', 'fixture-token-hash') RETURNING id`);
    const { rows: [oauth, pat, browser] } = await client.query<{ id: string }>(`INSERT INTO drafts (author_id, kind, lang, body, via, version, client_key, token_id)
      VALUES ('upgrade-author', 'topic', 'en', 'OAuth draft', 'api', 3, 'oauth:fixture', null),
             ('upgrade-author', 'topic', 'en', 'Legacy token draft', 'api', 2, null, $1),
             ('upgrade-author', 'topic', 'en', 'Browser draft', 'web', 1, null, null)
      RETURNING id`, [token.id]);

    const loadExistingRecords = async () => ({
      posts: (await client.query("SELECT id, title, body FROM entries WHERE id = $1", [entry.id])).rows,
      readings: (await client.query("SELECT method, count FROM entry_reading_counts WHERE entry_id = $1", [entry.id])).rows,
      drafts: (await client.query("SELECT id, body, version FROM drafts ORDER BY id")).rows,
    });
    const before = await loadExistingRecords();
    const migratedReceipts = async () => (await client.query("SELECT draft_id, author_id, client_key, state FROM draft_receipts ORDER BY draft_id")).rows;
    await migrateDatabase({ kind: "pg", url: scratch.url });

    expect(await loadExistingRecords()).toEqual(before);
    expect(before.drafts).toEqual([
      { id: oauth.id, body: "OAuth draft", version: 3 },
      { id: pat.id, body: "Legacy token draft", version: 2 },
      { id: browser.id, body: "Browser draft", version: 1 },
    ]);
    const receipts = [
      { draft_id: oauth.id, author_id: "upgrade-author", client_key: "oauth:fixture", state: "pending" },
      { draft_id: pat.id, author_id: "upgrade-author", client_key: `token:${token.id}`, state: "pending" },
    ];
    expect(await migratedReceipts()).toEqual(receipts);
    expect((await client.query(`SELECT (SELECT count(*)::int FROM entry_edit_proposals) AS edits,
      (SELECT count(*)::int FROM village_proposals) AS villages`)).rows).toEqual([{ edits: 0, villages: 0 }]);

    await migrateDatabase({ kind: "pg", url: scratch.url });
    expect(await migratedReceipts()).toEqual(receipts);
    expect(await loadExistingRecords()).toEqual(before);
  } finally {
    fs.rmSync(previous, { recursive: true, force: true });
    await scratch.drop();
  }
});
