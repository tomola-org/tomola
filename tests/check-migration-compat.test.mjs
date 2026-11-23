import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrationRisks, shouldCheckMigration } from '../scripts/check-migration-compat.mjs';

const kinds = sql => migrationRisks(sql).map(finding => finding.kind);

test('classifies drops, renames and type changes with PostgreSQL modifiers', () => {
  assert.deepEqual(kinds(`
    DrOp TABLE IF EXISTS "catalog"."a b";
    alter table if exists only "a b" drop column if exists "column";
    ALTER TABLE accounts DROP legacy_id;
    ALTER TABLE "accounts" RENAME TO members;
    ALTER TABLE "accounts" RENAME COLUMN "column" TO name;
    ALTER TABLE accounts RENAME CONSTRAINT "old name" TO "new name";
    DROP
      TYPE IF EXISTS "legacy status";
    ALTER TABLE accounts ALTER COLUMN "id" TYPE bigint;
    ALTER TABLE accounts ALTER id SET DATA TYPE numeric(10, 2);
  `), ['DROP TABLE', 'DROP COLUMN', 'DROP COLUMN', 'RENAME', 'RENAME', 'RENAME', 'DROP TYPE', 'ALTER COLUMN TYPE', 'ALTER COLUMN TYPE']);
});

test('classifies required columns, constraints, unique indexes and dropped defaults', () => {
  assert.deepEqual(kinds(`
    ALTER TABLE accounts ALTER name
      SET NOT NULL;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "rank" numeric(10, 2) NOT NULL;
    ALTER TABLE accounts
      ADD CONSTRAINT "unique id" UNIQUE (id),
      DROP CONSTRAINT IF EXISTS "check name",
      ALTER COLUMN name DROP DEFAULT;
    ALTER TABLE accounts ADD CHECK (rank >= 0);
    ALTER TABLE accounts ADD CONSTRAINT fk FOREIGN KEY (team) REFERENCES teams (id);
    ALTER TABLE accounts ADD CONSTRAINT dates EXCLUDE USING gist (period WITH &&);
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "lookup" ON "accounts" (name);
  `), ['SET NOT NULL', 'ADD COLUMN NOT NULL without DEFAULT', 'ADD CONSTRAINT', 'DROP CONSTRAINT', 'DROP DEFAULT', 'ADD CONSTRAINT', 'ADD CONSTRAINT', 'ADD CONSTRAINT', 'CREATE UNIQUE INDEX']);

  assert.deepEqual(kinds(`
    ALTER TABLE accounts ADD COLUMN label text NOT NULL DEFAULT 'new';
    ALTER TABLE accounts ADD COLUMN score int CHECK (score IS NOT NULL);
    ALTER TABLE accounts ADD COLUMN "not null" text, ADD COLUMN "default" text;
    ALTER TABLE accounts ALTER COLUMN label DROP NOT NULL;
    CREATE INDEX lookup ON accounts (name);
  `), []);
});

test('classifies data changes, including updates and deletes in a WITH statement', () => {
  assert.deepEqual(kinds(`
    DELETE
      FROM "accounts";
    UPDATE ONLY "accounts" AS a
      SET active = a.active;
    TRUNCATE TABLE "history";
    WITH changed AS (UPDATE accounts SET active = true RETURNING id)
    DELETE FROM history WHERE id IN (SELECT id FROM changed);
    WITH ids AS (SELECT id FROM accounts) UPDATE history SET active = true;
    SELECT id FROM accounts FOR UPDATE;
    WITH ids AS (SELECT id FROM accounts FOR UPDATE) SELECT id FROM ids;
  `), ['DELETE FROM', 'UPDATE SET', 'TRUNCATE', 'UPDATE SET', 'DELETE FROM', 'UPDATE SET']);
});

test('classifies trigger and function definitions at the statement level', () => {
  assert.deepEqual(kinds(`
    CREATE FUNCTION cleanup() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      DELETE FROM history;
      UPDATE accounts SET active = true;
    END $$;
    CREATE OR REPLACE
      FUNCTION cleanup() RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN
      DELETE FROM history;
    END $body$;
    DROP FUNCTION IF EXISTS "cleanup"();
    DROP TRIGGER IF EXISTS "sync" ON "accounts";
    CREATE TRIGGER "sync" AFTER UPDATE ON "accounts" FOR EACH ROW EXECUTE FUNCTION sync();
    CREATE OR REPLACE TRIGGER "sync" AFTER UPDATE ON "accounts" FOR EACH ROW EXECUTE FUNCTION sync();
  `), ['CREATE OR REPLACE FUNCTION', 'DROP FUNCTION', 'DROP TRIGGER', 'CREATE TRIGGER', 'CREATE TRIGGER']);
});

test('recognizes new tables in statement order and within one migration', () => {
  const sql = `
    CREATE TABLE inventory."New Items" (id int PRIMARY KEY);
    --> statement-breakpoint
    ALTER TABLE "inventory"."New Items" ADD CONSTRAINT ids UNIQUE (id);
    CREATE UNIQUE INDEX index_name ON inventory."New Items" (id);
    CREATE TRIGGER "sync" AFTER UPDATE ON inventory."New Items" FOR EACH ROW EXECUTE FUNCTION sync();
    ALTER TABLE inventory."New Items" DROP CONSTRAINT ids;
    CREATE TABLE IF NOT EXISTS accounts (id int);
    ALTER TABLE accounts ADD CONSTRAINT ids UNIQUE (id);
    ALTER TABLE inventory."new items" ADD CONSTRAINT ids UNIQUE (id);
  `;
  assert.deepEqual(kinds(sql), ['ADD CONSTRAINT', 'ADD CONSTRAINT']);
  assert.deepEqual(kinds('ALTER TABLE inventory."New Items" ADD CONSTRAINT ids UNIQUE (id);'), ['ADD CONSTRAINT']);
  assert.deepEqual(kinds('ALTER TABLE items ADD CONSTRAINT ids UNIQUE (id); CREATE TABLE items (id int);'), ['ADD CONSTRAINT']);
});

test('attaches a nonblank reason to only the immediately following statement', () => {
  const sql = [
    '-- compat: The previous release writes this column on every insert.',
    'ALTER TABLE accounts ALTER COLUMN active SET NOT NULL;--> statement-breakpoint',
    'DROP TABLE retired;',
    '-- compat:   ',
    'TRUNCATE history;--> statement-breakpoint',
    '-- compat: The previous release owns no rows in this table.',
    '',
    'DELETE FROM history;',
    'SELECT 1; -- compat: An inline comment belongs to the previous line.',
    'DROP TYPE retired_type;',
    '  -- compat: The previous release can read both values.',
    '  UPDATE accounts SET active = true; TRUNCATE history;',
    '-- compat: The previous release never reads the audit table.',
    'SELECT 1; DROP TABLE audit;',
  ].join('\r\n');
  assert.deepEqual(migrationRisks(sql), [
    { line: 3, kind: 'DROP TABLE', start: 'DROP TABLE retired' },
    { line: 5, kind: 'TRUNCATE', start: 'TRUNCATE history' },
    { line: 8, kind: 'DELETE FROM', start: 'DELETE FROM history' },
    { line: 10, kind: 'DROP TYPE', start: 'DROP TYPE retired_type' },
    { line: 12, kind: 'TRUNCATE', start: 'TRUNCATE history' },
    { line: 14, kind: 'DROP TABLE', start: 'DROP TABLE audit' },
  ]);
  assert.deepEqual(kinds(`
    -- compat: The previous release can read both values.
    UPDATE accounts SET active = true--> statement-breakpoint TRUNCATE history;
  `), ['TRUNCATE']);
});

test('ignores SQL-looking text and delimiters in comments, literals and quoted names', () => {
  const sql = String.raw`
    -- DROP TABLE history;
    /* Nested comment /* TRUNCATE history; */ DROP TYPE retired; */
    SELECT 'UPDATE x SET name = ''example''; --> statement-breakpoint';
    SELECT E'It\'s a string; DELETE FROM history;';
    SELECT $text$ DROP FUNCTION sync(); --> statement-breakpoint $text$;
    SELECT "DROP TABLE" AS "name; --> statement-breakpoint";
    /*
    -- compat: This text is part of a block comment.
    */
    DROP TABLE history;
  `;
  assert.deepEqual(kinds(sql), ['DROP TABLE']);
});

test('checks only SQL migration numbers from the compatibility cutoff', () => {
  assert.ok(!shouldCheckMigration('0000_start.sql'));
  assert.ok(!shouldCheckMigration('0131_previous.sql'));
  assert.ok(shouldCheckMigration('0132_next.sql'));
  assert.ok(shouldCheckMigration('0140_later.sql'));
  assert.ok(!shouldCheckMigration('0132_snapshot.json'));
  assert.ok(!shouldCheckMigration('notes.sql'));
});
