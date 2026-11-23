import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FIRST_CHECKED_MIGRATION = 132;
const BREAKPOINT = '--> statement-breakpoint';

export function shouldCheckMigration(file) {
  const number = /^(\d{4,})[^/]*\.sql$/.exec(file)?.[1];
  return number !== undefined && Number(number) >= FIRST_CHECKED_MIGRATION;
}

function skipBlockComment(sql, start) {
  const delimiters = /\/\*|\*\//g;
  delimiters.lastIndex = start;
  let depth = 1;
  for (const match of sql.matchAll(delimiters)) {
    depth += match[0] === '/*' ? 1 : -1;
    if (depth === 0) return match.index + match[0].length;
  }
  return sql.length;
}

function skipString(sql, start, escapes) {
  const delimiters = escapes ? /\\[\s\S]|''|'/g : /''|'/g;
  delimiters.lastIndex = start;
  for (const match of sql.matchAll(delimiters)) {
    if (match[0] === "'") return match.index + 1;
  }
  return sql.length;
}

function* lex(sql) {
  const pieces = /--[^\r\n]*|\/\*|e?'|"(?:[^"]|"")*"|\$(?:[a-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$|[a-z_\u0080-\uffff][\w$\u0080-\uffff]*|\S/gi;
  for (let match; (match = pieces.exec(sql)); ) {
    const [raw] = match;
    if (raw === '/*') {
      pieces.lastIndex = skipBlockComment(sql, pieces.lastIndex);
      continue;
    }
    let token = raw.toLowerCase();
    if (raw.startsWith(BREAKPOINT)) {
      pieces.lastIndex = match.index + BREAKPOINT.length;
      token = BREAKPOINT;
    } else if (raw.endsWith("'")) {
      pieces.lastIndex = skipString(sql, pieces.lastIndex, raw.length === 2);
      token = '';
    } else if (raw.length > 1 && raw.startsWith('$')) {
      const end = sql.indexOf(raw, pieces.lastIndex);
      pieces.lastIndex = end < 0 ? sql.length : end + raw.length;
      token = '';
    } else if (raw.startsWith('"') || raw.startsWith('--')) {
      token = raw;
    }
    yield { token, offset: match.index };
  }
}

function* statements(sql) {
  let tokens = [];
  let offset;
  let annotation;
  let annotated;
  let depth = 0;
  for (const piece of lex(sql)) {
    const { token } = piece;
    if ((token === ';' && depth === 0) || token === BREAKPOINT) {
      if (tokens.length) yield { tokens, offset, end: piece.offset, annotated };
      tokens = [];
      annotation = undefined;
      depth = 0;
    } else if (token.startsWith('--')) {
      if (/^-- compat:\s*\S/.test(token)) annotation = piece;
    } else {
      if (!tokens.length) {
        offset = piece.offset;
        annotated = false;
        if (annotation) {
          const lineStart = Math.max(sql.lastIndexOf('\n', annotation.offset - 1), sql.lastIndexOf('\r', annotation.offset - 1)) + 1;
          const prefix = sql.slice(lineStart, annotation.offset);
          const gap = sql.slice(annotation.offset + annotation.token.length, offset);
          annotated = /^[\t ]*$/.test(prefix) && /^(?:\r\n|\r|\n)[\t ]*$/.test(gap);
        }
      }
      tokens.push(token);
      if (token === '(' || token === '[') depth++;
      if (token === ')' || token === ']') depth--;
    }
  }
  if (tokens.length) yield { tokens, offset, end: sql.length, annotated };
}

function startsWith(tokens, words, offset = 0) {
  return words.every((word, index) => tokens[offset + index] === word);
}

const isIdentifier = token => /^[a-z_\u0080-\uffff"]/i.test(token ?? '');

function qualifiedName(tokens, offset) {
  if (tokens[offset] === 'only') offset++;
  const parts = [];
  while (isIdentifier(tokens[offset])) {
    const token = tokens[offset++];
    parts.push(token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token);
    if (tokens[offset] !== '.') break;
    offset++;
  }
  return { parts, name: parts.length ? JSON.stringify(parts) : undefined, end: offset };
}

function* droppedIndexes(tokens) {
  let offset = tokens[2] === 'concurrently' ? 3 : 2;
  if (startsWith(tokens, ['if', 'exists'], offset)) offset += 2;
  while (offset < tokens.length) {
    const { name, end } = qualifiedName(tokens, offset);
    yield name;
    if (tokens[end] !== ',') return;
    offset = end + 1;
  }
}

function* topLevel(tokens) {
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token === ')' || token === ']') depth--;
    if (depth === 0) yield index;
    if (token === '(' || token === '[') depth++;
  }
}

function* alterTableActions(tokens) {
  let start = 0;
  for (const index of topLevel(tokens)) {
    if (tokens[index] !== ',') continue;
    yield tokens.slice(start, index);
    start = index + 1;
  }
  yield tokens.slice(start);
}

function alterTableRisk(action, newTable) {
  const [verb, object] = action;
  if (verb === 'rename') return 'RENAME';
  if (startsWith(action, ['set', 'schema'])) return 'ALTER TABLE SET SCHEMA';
  if (startsWith(action, ['disable', 'trigger'])) return 'ALTER TABLE DISABLE TRIGGER';
  if (verb === 'drop') {
    if (object === 'constraint') return newTable ? undefined : 'DROP CONSTRAINT';
    if (isIdentifier(object)) return 'DROP COLUMN';
  }
  if (verb === 'alter') {
    const operation = object === 'column' ? 3 : 2;
    if (action[operation] === 'type' || startsWith(action, ['set', 'data', 'type'], operation)) return 'ALTER COLUMN TYPE';
    if (startsWith(action, ['set', 'not', 'null'], operation)) return 'SET NOT NULL';
    if (startsWith(action, ['drop', 'default'], operation)) return 'DROP DEFAULT';
  }
  if (verb === 'add') {
    if (['constraint', 'check', 'unique', 'foreign', 'exclude', 'primary'].includes(object)) {
      return newTable ? undefined : 'ADD CONSTRAINT';
    }
    let column = object === 'column' ? 2 : 1;
    if (startsWith(action, ['if', 'not', 'exists'], column)) column += 3;
    const options = [...topLevel(action)].filter(index => index > column);
    if (!options.some(index => action[index] === 'default')) {
      if (options.some(index => startsWith(action, ['not', 'null'], index))) return 'ADD COLUMN NOT NULL without DEFAULT';
      if (options.some(index => startsWith(action, ['primary', 'key'], index))) return 'ADD COLUMN PRIMARY KEY without DEFAULT';
    }
  }
}

function* rowChanges(tokens) {
  if (startsWith(tokens, ['delete', 'from'])) yield 'DELETE FROM';
  if (tokens[0] === 'update' && [...topLevel(tokens)].some(index => tokens[index] === 'set')) yield 'UPDATE SET';
  if (tokens[0] === 'truncate') yield 'TRUNCATE';
  if (startsWith(tokens, ['merge', 'into'])) yield 'MERGE';
  if (startsWith(tokens, ['insert', 'into'])) {
    const positions = [...topLevel(tokens)];
    const conflict = positions.find(index => startsWith(tokens, ['on', 'conflict'], index));
    if (conflict !== undefined && positions.some(index => index > conflict && startsWith(tokens, ['do', 'update', 'set'], index))) {
      yield 'INSERT ON CONFLICT DO UPDATE';
    }
  }
  if (tokens[0] !== 'with') return;

  // Inspect the statements in CTEs and the command that follows them.
  const positions = [...topLevel(tokens)];
  for (const [index, position] of positions.entries()) {
    if (tokens[position] === '(' && tokens[positions[index + 1]] === ')') {
      if (['as', 'materialized'].includes(tokens[position - 1])) {
        yield* rowChanges(tokens.slice(position + 1, positions[index + 1]));
      }
    }
    const command = tokens[position];
    const next = tokens[position + 1];
    if (command === 'select'
      || (command === 'update' && next !== 'as' && next !== '(')
      || (command === 'delete' && next === 'from')
      || (['insert', 'merge'].includes(command) && next === 'into')) {
      yield* rowChanges(tokens.slice(position));
      return;
    }
  }
}

function* statementRisks(tokens, newTables, newIndexes) {
  const [verb, object] = tokens;
  if (verb === 'drop' && ['table', 'type', 'function', 'trigger', 'view', 'procedure'].includes(object)) yield `DROP ${object.toUpperCase()}`;
  if (startsWith(tokens, ['drop', 'materialized', 'view'])) yield 'DROP MATERIALIZED VIEW';
  if (startsWith(tokens, ['drop', 'index'])) {
    const indexes = [...droppedIndexes(tokens)];
    const createdHere = indexes.filter(name => newIndexes.delete(name));
    if (!indexes.length || createdHere.length !== indexes.length) yield 'DROP INDEX';
  }
  if (startsWith(tokens, ['alter', 'table'])) {
    const target = qualifiedName(tokens, startsWith(tokens, ['if', 'exists'], 2) ? 4 : 2);
    const actions = tokens.slice(target.end + Number(tokens[target.end] === '*'));
    for (const action of alterTableActions(actions)) {
      const risk = alterTableRisk(action, newTables.has(target.name));
      if (risk) yield risk;
    }
  }
  if (verb === 'alter' && ['type', 'function', 'index'].includes(object)) {
    const target = qualifiedName(tokens, object === 'index' && startsWith(tokens, ['if', 'exists'], 2) ? 4 : 2);
    let action = target.end;
    if (object === 'function' && tokens[action] === '(') {
      const signatureEnd = [...topLevel(tokens)].find(index => index > action && tokens[index] === ')');
      if (signatureEnd !== undefined) action = signatureEnd + 1;
    }
    if (startsWith(tokens, ['rename', 'to'], action)) {
      yield object === 'type' ? 'ALTER TYPE RENAME TO' : `ALTER ${object.toUpperCase()} RENAME`;
      if (object === 'index' && newIndexes.delete(target.name)) {
        const { parts } = qualifiedName(tokens, action + 2);
        newIndexes.add(JSON.stringify([...target.parts.slice(0, -1), ...parts]));
      }
    }
    if (object === 'type' && startsWith(tokens, ['rename', 'value'], action)) yield 'ALTER TYPE RENAME VALUE';
  }
  yield* rowChanges(tokens);
  if (verb !== 'create') return;
  const createObject = startsWith(tokens, ['or', 'replace'], 1) ? 3 : 1;
  if (createObject === 3) {
    const replaced = tokens[3];
    const viewOption = 3 + Number(['temp', 'temporary'].includes(replaced));
    const view = tokens[viewOption + Number(tokens[viewOption] === 'recursive')] === 'view';
    if (view) yield 'CREATE OR REPLACE VIEW';
    if (['function', 'procedure'].includes(replaced)) yield `CREATE OR REPLACE ${replaced.toUpperCase()}`;
  }
  const constraint = tokens[createObject] === 'constraint';
  const trigger = tokens[createObject + Number(constraint)] === 'trigger';
  const uniqueIndex = startsWith(tokens, ['create', 'unique', 'index']);
  const index = uniqueIndex || object === 'index';
  if (trigger || index) {
    const on = tokens.indexOf('on', createObject + 1);
    if (on < 0) return;
    const target = qualifiedName(tokens, on + 1);
    if ((trigger || uniqueIndex) && !newTables.has(target.name)) {
      yield trigger ? 'CREATE TRIGGER' : 'CREATE UNIQUE INDEX';
    }
    if (index) {
      const first = uniqueIndex ? 3 : 2;
      const nameOffset = first + Number(tokens[first] === 'concurrently');
      // An unnamed index or IF NOT EXISTS does not establish a newly created name.
      if (on === nameOffset + 1 && target.name) {
        const { parts } = qualifiedName(tokens, nameOffset);
        if (parts.length) newIndexes.add(JSON.stringify([...target.parts.slice(0, -1), ...parts]));
      }
    }
  }
}

export function migrationRisks(sql) {
  const newTables = new Set();
  const newIndexes = new Set();
  const findings = [];
  for (const { tokens, offset, end, annotated } of statements(sql)) {
    const risks = new Set(statementRisks(tokens, newTables, newIndexes));
    if (!annotated && risks.size) {
      for (const kind of risks) {
        const line = sql.slice(0, offset).split(/\r\n|\r|\n/).length;
        const start = sql.slice(offset, end).split(/\r\n|\r|\n/, 1)[0].trimEnd().slice(0, 120);
        findings.push({ line, kind, start });
      }
    }
    const table = ['temp', 'temporary', 'unlogged'].includes(tokens[1]) ? 2 : 1;
    if (tokens[0] === 'create' && tokens[table] === 'table' && tokens[table + 1] !== 'if') {
      const { name } = qualifiedName(tokens, table + 1);
      if (name) newTables.add(name);
    }
  }
  return findings;
}

function main() {
  const files = fs.readdirSync('drizzle', { withFileTypes: true })
    .filter(file => file.isFile() && shouldCheckMigration(file.name))
    .map(file => file.name).sort();
  let count = 0;
  for (const file of files) {
    const target = path.posix.join('drizzle', file);
    for (const { line, kind, start } of migrationRisks(fs.readFileSync(target, 'utf8'))) {
      console.error(`${target}:${line}: ${kind}: ${start}`);
      count++;
    }
  }
  if (count) {
    console.error('See “Migration compatibility during deployment” in docs/deploy.md.');
    console.error('Keep the change compatible with the previous release and place `-- compat: <one English sentence explaining why the previous release can still read and write>` immediately above the statement.');
  } else {
    console.log(`Migration compatibility lint passed (${files.length} migrations checked).`);
  }
  return count ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
