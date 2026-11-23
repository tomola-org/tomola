import { and, asc, eq, inArray, ne, sql, type SQLWrapper } from "drizzle-orm";
import type { AiQuestionAnswer } from "./ai-questions";
import type { Tx } from "./db/client.server";
import { chatMessages, chatMessageTranslations, chatNushiRequests, chatNushiSources, nushiAnswers, nushiSources, nushiTranslations } from "./db/schema";
import { DELETED_MEMBER_HANDLE } from "./deleted-member";
import { mentionCandidates } from "./mention-syntax";
import { deleteRetentionRows } from "./retention-batch.server";
import { nextChatSequence } from "./village-chat-sequence.server";

const sourceIds = (entryId: number) => [`e-${entryId}-title`, `e-${entryId}-body`];
const authorKey = (author: string) => author.normalize("NFKC").toLowerCase();
const authorMentions = (text: string, authors: ReadonlySet<string>) => mentionCandidates(text)
  .filter(({ token }) => authors.has(authorKey(`@${token}`)));

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

function entryCopies(entryId: SQLWrapper) {
  const answers = sql`select answer_id from ${nushiSources} where entry_id = ${entryId}`;
  const chat = sql`select answer_message_id from ${chatNushiRequests} inner join ${chatNushiSources}
    on ${chatNushiSources.requestId} = ${chatNushiRequests.id} where ${chatNushiSources.entryId} = ${entryId}`;
  return {
    sources: sql`${nushiSources.entryId} = ${entryId} and ${nushiSources.author} <> ''`,
    translations: sql`${nushiTranslations.answerId} in (${answers})`,
    chatBodies: sql`${chatMessages.id} in (${chat}) and ${chatMessages.body} <> ''`,
    chatTranslations: sql`${chatMessageTranslations.messageId} in (${chat})`,
  };
}

export function pendingNushiEntryCopies(entryId: SQLWrapper) {
  const copies = entryCopies(entryId);
  return [
    { table: nushiSources, where: copies.sources, mutations: 2 },
    { table: nushiTranslations, where: copies.translations, mutations: 1 },
    { table: chatMessages, where: copies.chatBodies, mutations: 1 },
    { table: chatMessageTranslations, where: copies.chatTranslations, mutations: 1 },
  ];
}

export async function pruneNushiEntryCopies(tx: Tx, entryId: number, limit: number) {
  if (limit <= 0) return 0;
  const copies = entryCopies(sql`${entryId}`);
  const sources = limit >= 2 ? await tx.select({ id: nushiAnswers.id, answer: nushiAnswers.answer, author: nushiSources.author })
    .from(nushiSources).innerJoin(nushiAnswers, eq(nushiAnswers.id, nushiSources.answerId))
    .where(copies.sources).orderBy(asc(nushiAnswers.id)).limit(Math.floor(limit / 2))
    .for("no key update", { of: nushiAnswers, skipLocked: true }) : [];
  for (const { id, answer, author } of sources) {
    await tx.update(nushiAnswers).set({ answer: eraseSource(answer, entryId, author) }).where(eq(nushiAnswers.id, id));
    // Keep the provenance link for other cleanup passes and report evidence.
    await tx.update(nushiSources).set({ author: "" }).where(and(eq(nushiSources.answerId, id), eq(nushiSources.entryId, entryId)));
  }
  let changed = sources.length * 2;
  changed += await deleteRetentionRows(tx, nushiTranslations, copies.translations, limit - changed);
  // Erase residual chat text while preserving any existing visibility marker.
  const messages = changed < limit ? await tx.select({ id: chatMessages.id, hiddenAt: chatMessages.hiddenAt, deletedAt: chatMessages.deletedAt, villageId: chatMessages.villageId })
    .from(chatMessages).where(copies.chatBodies).orderBy(asc(chatMessages.villageId), asc(chatMessages.id))
    .limit(limit - changed).for("update", { skipLocked: true }) : [];
  for (const message of messages) {
    const visibility = message.hiddenAt || message.deletedAt ? {} : { hiddenAt: new Date(), changedSeq: await nextChatSequence(tx, message.villageId) };
    await tx.update(chatMessages).set({ body: "", nushiShape: null, ...visibility }).where(eq(chatMessages.id, message.id));
  }
  changed += messages.length;
  changed += await deleteRetentionRows(tx, chatMessageTranslations, copies.chatTranslations, limit - changed);
  return changed;
}

export async function anonymizeNushiAnswers(tx: Tx, userId: string) {
  const memberSources = and(eq(nushiSources.authorId, userId), ne(nushiSources.author, ""));
  const answers = await tx.select({ id: nushiAnswers.id, answer: nushiAnswers.answer }).from(nushiAnswers)
    .where(inArray(nushiAnswers.id, tx.select({ id: nushiSources.answerId }).from(nushiSources).where(memberSources)))
    .orderBy(asc(nushiAnswers.id)).for("no key update");
  if (!answers.length) return;
  const sources = await tx.select({ answerId: nushiSources.answerId, entryId: nushiSources.entryId, author: nushiSources.author })
    .from(nushiSources).where(memberSources);
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
    await tx.update(nushiAnswers).set({ answer: { ...answer, citations, readings } }).where(eq(nushiAnswers.id, id));
  }
  await tx.update(nushiSources).set({ author: DELETED_MEMBER_HANDLE }).where(memberSources);
}
