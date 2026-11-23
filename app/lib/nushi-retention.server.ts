import { and, asc, eq, inArray, ne, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AiQuestionAnswer } from "./ai-questions";
import type { Tx } from "./db/client.server";
import { chatMessages, chatMessageTranslations, chatNushiRequests, chatNushiSources, nushiAnswers, nushiReports, nushiSources, nushiTranslations } from "./db/schema";
import { DELETED_MEMBER_HANDLE } from "./deleted-member";
import { mentionCandidates } from "./mention-syntax";
import { deleteRetentionRows, updateRetentionRows } from "./retention-batch.server";

const sourceIds = (entryId: number) => [`e-${entryId}-title`, `e-${entryId}-body`];
const authorKey = (author: string) => author.normalize("NFKC").toLowerCase();
const authorMentions = (text: string, authors: ReadonlySet<string>) => mentionCandidates(text)
  .filter(({ token }) => authors.has(authorKey(`@${token}`)));

function anonymizeAnswer(answer: AiQuestionAnswer, ids: ReadonlySet<string>, authors: Set<string>): AiQuestionAnswer {
  const citations = answer.citations.map(citation => {
    if (!ids.has(citation.sourceId)) return citation;
    authors.add(authorKey(citation.author));
    return { ...citation, author: DELETED_MEMBER_HANDLE };
  });
  const readings = answer.readings.map(reading => {
    let text = reading.text;
    for (const { start, end } of authorMentions(text, authors).reverse()) text = text.slice(0, start) + DELETED_MEMBER_HANDLE + text.slice(end);
    return { ...reading, text };
  });
  return { ...answer, citations, readings };
}

function eraseSource(answer: AiQuestionAnswer, entryId: number, author: string): AiQuestionAnswer {
  const ids = sourceIds(entryId);
  const authors = new Set([authorKey(author)]);
  const citations: AiQuestionAnswer["citations"] = [];
  const positions = new Map<number, number>();
  answer.citations.forEach((citation, index) => {
    if (ids.includes(citation.sourceId)) authors.add(authorKey(citation.author));
    else positions.set(index + 1, citations.push(citation));
  });
  if (!citations.length) return { status: "not_confirmed", readings: [], citations: [] };
  // Drop readings that depend on an erased passage, and attributions that
  // cannot be tied to another retained citation by the same writer.
  const readings = answer.readings.flatMap(reading => {
    const references = reading.citations.flatMap(position => positions.get(position) ?? []);
    if (references.length !== reading.citations.length) return [];
    const retainedAuthors = new Set(references.map(position => authorKey(citations[position - 1].author)));
    if (authorMentions(reading.text, authors).some(({ token }) => !retainedAuthors.has(authorKey(`@${token}`)))) return [];
    return [{ ...reading, citations: references }];
  });
  return { ...answer, readings, citations };
}

function hiddenChatCopies(source: SQL) {
  // Source withdrawal handles visible answers and owns their chat sequence changes.
  const messages = sql`select ${chatNushiRequests.answerMessageId} from ${chatNushiRequests} inner join ${chatNushiSources}
    on ${chatNushiSources.requestId} = ${chatNushiRequests.id} where ${source}`;
  const hidden = sql`${chatMessages.id} in (${messages}) and (${chatMessages.hiddenAt} is not null or ${chatMessages.deletedAt} is not null)`;
  return {
    chatBodies: sql`${hidden} and ${chatMessages.body} <> ''`,
    chatTranslations: sql`${chatMessageTranslations.messageId} in (select ${chatMessages.id} from ${chatMessages} where ${hidden})`,
  };
}

function entryCopies(entryId: SQLWrapper) {
  const answers = sql`select ${nushiSources.answerId} from ${nushiSources} where ${nushiSources.entryId} = ${entryId}`;
  const scopeHashes = sql`exists (select 1 from ${nushiAnswers}, jsonb_array_elements(${nushiAnswers.scope}->'materialIndex') material
    where ${nushiAnswers.id} = ${nushiSources.answerId} and material->'translation'->>'hash' is not null
    and material->>'id' in ('e-' || ${nushiSources.entryId} || '-title', 'e-' || ${nushiSources.entryId} || '-body'))`;
  return {
    sources: sql`${nushiSources.entryId} = ${entryId} and (${nushiSources.author} <> '' or ${nushiSources.textHash} is not null or ${nushiSources.sourceHash} <> '' or ${scopeHashes})`,
    translations: sql`${nushiTranslations.answerId} in (${answers})`,
    chatSources: sql`${chatNushiSources.entryId} = ${entryId} and ${chatNushiSources.sourceHash} <> ''`,
    ...hiddenChatCopies(sql`${chatNushiSources.entryId} = ${entryId}`),
  };
}

export function pendingNushiEntryCopies(entryId: SQLWrapper) {
  const copies = entryCopies(entryId);
  return [
    { table: nushiSources, where: copies.sources, mutations: 2 },
    { table: nushiTranslations, where: copies.translations, mutations: 1 },
    { table: chatNushiSources, where: copies.chatSources, mutations: 1 },
    { table: chatMessages, where: copies.chatBodies, mutations: 1 },
    { table: chatMessageTranslations, where: copies.chatTranslations, mutations: 1 },
  ];
}

export async function pruneNushiEntryCopies(tx: Tx, entryId: number, now: Date, limit: number) {
  if (limit <= 0) return 0;
  const copies = entryCopies(sql`${entryId}`);
  // Drain translations within the budget before hiding an answer whose marker is missing.
  let changed = await deleteRetentionRows(tx, nushiTranslations, copies.translations, limit);
  const sources = limit - changed >= 2 ? await tx.select({ id: nushiAnswers.id, answer: nushiAnswers.answer, scope: nushiAnswers.scope, hiddenAt: nushiAnswers.hiddenAt, author: nushiSources.author })
    .from(nushiSources).innerJoin(nushiAnswers, eq(nushiAnswers.id, nushiSources.answerId))
    .where(and(copies.sources, sql`(${nushiAnswers.hiddenAt} is not null or not exists (
      select 1 from ${nushiTranslations} where ${nushiTranslations.answerId} = ${nushiAnswers.id}))`))
    .orderBy(asc(nushiAnswers.id)).limit(Math.floor((limit - changed) / 2))
    .for("no key update", { of: nushiAnswers, skipLocked: true }) : [];
  const ids = sourceIds(entryId);
  for (const { id, answer, scope, hiddenAt, author } of sources) {
    const materialIndex = scope.materialIndex.map(material => ids.includes(material.id) ? { id: material.id, chars: material.chars } : material);
    const visibility = hiddenAt ? {} : { hiddenAt: now, hiddenReason: "source_changed" };
    await tx.update(nushiAnswers).set({ answer: eraseSource(answer, entryId, author), scope: { ...scope, materialIndex }, ...visibility }).where(eq(nushiAnswers.id, id));
    // Keep the provenance link for other cleanup passes and report evidence.
    await tx.update(nushiSources).set({ author: "", textHash: null, sourceHash: "" }).where(and(eq(nushiSources.answerId, id), eq(nushiSources.entryId, entryId)));
  }
  changed += sources.length * 2;
  changed += await updateRetentionRows(tx, chatNushiSources, copies.chatSources, sql`source_hash = ''`, limit - changed);
  changed += await updateRetentionRows(tx, chatMessages, copies.chatBodies, sql`body = '', nushi_shape = null`, limit - changed);
  changed += await deleteRetentionRows(tx, chatMessageTranslations, copies.chatTranslations, limit - changed);
  return changed;
}

export async function anonymizeNushiAnswers(tx: Tx, userId: string) {
  const owned = eq(nushiSources.authorId, userId);
  const memberSources = and(owned, ne(nushiSources.author, ""));
  const answers = await tx.select({ id: nushiAnswers.id, answer: nushiAnswers.answer }).from(nushiAnswers)
    .where(inArray(nushiAnswers.id, tx.select({ id: nushiSources.answerId }).from(nushiSources).where(memberSources)))
    .orderBy(asc(nushiAnswers.id)).for("no key update");
  const sources = await tx.select({ answerId: nushiSources.answerId, entryId: nushiSources.entryId, author: nushiSources.author })
    .from(nushiSources).where(owned);
  const byAnswer = new Map<number, typeof sources>();
  for (const source of sources) {
    const group = byAnswer.get(source.answerId);
    if (group) group.push(source);
    else byAnswer.set(source.answerId, [source]);
  }
  for (const { id, answer } of answers) {
    const related = byAnswer.get(id) ?? [];
    const ids = new Set(related.flatMap(source => sourceIds(source.entryId)));
    const authors = new Set(related.map(source => authorKey(source.author)));
    await tx.update(nushiAnswers).set({ answer: anonymizeAnswer(answer, ids, authors) }).where(eq(nushiAnswers.id, id));
  }
  await tx.update(nushiSources).set({ author: DELETED_MEMBER_HANDLE }).where(memberSources);

  // Consented evidence keeps its passages and follows the same attribution rules.
  const reports = await tx.select({ id: nushiReports.id, answerId: nushiReports.answerId, evidence: nushiReports.evidence }).from(nushiReports)
    .where(and(eq(nushiReports.kind, "error"), inArray(nushiReports.answerId, tx.select({ id: nushiSources.answerId }).from(nushiSources).where(owned))))
    .orderBy(asc(nushiReports.id)).for("no key update");
  for (const report of reports) {
    const evidence = report.evidence as { materials: Array<{ id: string; author: string }>; answer: AiQuestionAnswer };
    const related = byAnswer.get(report.answerId) ?? [];
    const ids = new Set(related.flatMap(source => sourceIds(source.entryId)));
    const authors = new Set(related.map(source => authorKey(source.author)));
    const materials = evidence.materials.map(material => {
      if (!ids.has(material.id)) return material;
      authors.add(authorKey(material.author));
      return { ...material, author: DELETED_MEMBER_HANDLE };
    });
    await tx.update(nushiReports).set({ evidence: { ...evidence, materials, answer: anonymizeAnswer(evidence.answer, ids, authors) } }).where(eq(nushiReports.id, report.id));
  }
}

export async function clearHiddenChatNushiCopies(tx: Tx, userId: string) {
  const copies = hiddenChatCopies(eq(chatNushiSources.authorId, userId));
  await tx.update(chatMessages).set({ body: "", nushiShape: null }).where(copies.chatBodies);
  await tx.delete(chatMessageTranslations).where(copies.chatTranslations);
}
