import { createHash } from "node:crypto";
import type { Lang } from "~/lib/languages";
import { FLAG_LINK_MISMATCH, FLAG_QUALITY_MISMATCH, FLAG_STRUCTURE_MISMATCH, FLAG_UNTRANSLATED, FLAG_UNTRANSLATED_SCRIPT, FLAG_UNTRANSLATED_SIMILAR } from "./flags";
import { LINK_MISMATCH_RETRY, type inspectTranslation as inspectCore, type judgeCopy as judgeCopyCore, type looksUntranslated as looksUntranslatedCore } from "./translation-inspect.core.server";
import { markdownTask, MarkdownBudgetError } from "../markdown-budget.server";
import { FLAG_MARKDOWN_BUDGET } from "./flags";

import type { TranslationEngine, TranslationRequest, TranslationResult } from "./types";
import { FLAG_OUTPUT_LEAK } from "./flags";
import { LlmError } from "./errors.server";
import { KEEP_LINK_MARKERS, usesPostTranslationPrompt } from "./prompt.server";

export type ProtectedTranslationContext = Pick<TranslationRequest, "titleBodyContext" | "terminology">;

// translations.flags constants live in ./flags; also re-exported here for existing imports.
export { FLAG_LINK_MISMATCH, FLAG_QUALITY_MISMATCH, FLAG_STRUCTURE_MISMATCH, FLAG_UNTRANSLATED, FLAG_UNTRANSLATED_SCRIPT, FLAG_UNTRANSLATED_SIMILAR };

export type CheckedTranslation = TranslationResult & {
  // Flags added to translations.flags when accepting output; see ./flags for display rules.
  flags: string[];
  // Engine calls: 1, or 2 after failed checks. Token counts total all calls.
  attempts: number;
  // Rejected outputs with a leak, including one fixed by the retry.
  leakDetections: number;
};

export { UNTRANSLATED_MIN_LENGTH } from "./translation-inspect.core.server";
export function judgeCopy(...args: Parameters<typeof judgeCopyCore>): Promise<ReturnType<typeof judgeCopyCore>> { return markdownTask("judgeCopy", args); }
export async function looksUntranslated(...args: Parameters<typeof looksUntranslatedCore>): Promise<boolean> { return (await judgeCopy(...args)).copy; }
const markdownBudgetProblems = () => ({ flags: [FLAG_MARKDOWN_BUDGET], notes: ["Your previous output could not be processed within the formatting budget. Translate again using simpler markup, while preserving the source content."] });

export async function inspectTranslation(...args: Parameters<typeof inspectCore>): Promise<ReturnType<typeof inspectCore>> {
  try { return await markdownTask("inspectTranslation", args); }
  catch (error) {
    if (!(error instanceof MarkdownBudgetError)) throw error;
    return markdownBudgetProblems();
  }
}

export async function prepareTranslationLinks(req: TranslationRequest, context?: ProtectedTranslationContext) {
  if (!usesPostTranslationPrompt(req)) return { request: req, links: undefined };
  const { text, targets, literals } = await markdownTask("maskLinkTargets", [req.text]);
  const maskedSourceHash = createHash("sha256").update(JSON.stringify([req.text, req.titleBodyContext, req.terminology])).digest("hex");
  const { terminology, ...input } = { ...req, ...context };
  const request = { ...input, ...(terminology ? { terminology } : {}), text, maskedSourceHash };
  return { request, links: { targets, literals } };
}

// Translate and check structure, links and untranslated output. On failure, retry once with a warning.
// Persistent output leaks throw a terminal error before storage. Other failed
// checks flag the second output. The structure_mismatch warning remains
// visible; quality_mismatch hides strong preservation failures. Other display
// rules live in ./flags. Rethrow engine failures unchanged.
export async function translateChecked(engine: TranslationEngine, req: TranslationRequest, options: {
  context?: ProtectedTranslationContext;
  beforeCall?: (input: TranslationRequest) => Promise<void>;
  replayLegacy?: (input: TranslationRequest) => TranslationResult | undefined;
} = {}): Promise<CheckedTranslation> {
  let prepared: Awaited<ReturnType<typeof prepareTranslationLinks>> | undefined;
  async function attempt(retryNote?: string, legacy = true) {
    const original = retryNote === undefined ? req : { ...req, retryNote };
    const replay = legacy ? options.replayLegacy?.(original) : undefined;
    if (replay) return { result: replay, legacy: true };
    prepared ??= await prepareTranslationLinks(req, options.context);
    const request = retryNote === undefined ? prepared.request : { ...prepared.request, retryNote };
    if (retryNote === undefined) await options.beforeCall?.(request);
    return { result: await engine.translate(request), legacy: false };
  }
  async function check(result: TranslationResult, legacy: boolean) {
    let invalidMarkers = false;
    let text = result.text;
    const links = legacy ? undefined : prepared?.links;
    const hasMarkers = !!links && Object.keys(links.targets).length > 0;
    if (links && (hasMarkers || /TMLINK/i.test(text))) {
      const prefix = engine.id === "fake" ? /^\[[^\]\n]+\] /.exec(text)?.[0] ?? "" : "";
      try {
        const restored = await markdownTask("restoreLinkTargets", [text.slice(prefix.length), links.targets, links.literals]);
        text = prefix + restored.text;
        invalidMarkers = !restored.valid;
      } catch (error) {
        if (!(error instanceof MarkdownBudgetError)) throw error;
        return { ...markdownBudgetProblems(), text: req.text };
      }
    }
    const problems = await inspectTranslation(req, text, engine.id);
    if (invalidMarkers && !problems.flags.includes(FLAG_LINK_MISMATCH)) {
      problems.flags.push(FLAG_LINK_MISMATCH);
      if (!hasMarkers) problems.notes.push(LINK_MISMATCH_RETRY);
    }
    if (hasMarkers && problems.flags.includes(FLAG_LINK_MISMATCH)) problems.notes.push(KEEP_LINK_MARKERS);
    return { ...problems, text: problems.normalizedText ?? text };
  }
  let leakDetections = 0;
  try {
    const { result: first, legacy } = await attempt();
    const firstProblems = await check(first, legacy);
    if (firstProblems.flags.includes(FLAG_OUTPUT_LEAK)) leakDetections++;
    if (req.figure && req.figureCharacterBudgets) {
      if (firstProblems.flags.includes(FLAG_OUTPUT_LEAK)) throw new LlmError("output_leak", "Figure shortening output failed the leak check");
      return { ...first, flags: firstProblems.flags, attempts: 1, leakDetections };
    }
    if (firstProblems.notes.length === 0) return { ...first, text: firstProblems.text, flags: [], attempts: 1, leakDetections };

    const { result: second, legacy: legacyRetry } = await attempt(firstProblems.notes.join(" Also, "), legacy);
    const secondProblems = await check(second, legacyRetry);
    if (secondProblems.flags.includes(FLAG_OUTPUT_LEAK)) {
      leakDetections++;
      throw new LlmError("output_leak", "Translation output failed the leak check after one retry");
    }
    return {
      ...second,
      text: secondProblems.text,
      inputTokens: first.inputTokens + second.inputTokens,
      outputTokens: first.outputTokens + second.outputTokens,
      ...(first.thoughtTokens !== undefined || second.thoughtTokens !== undefined ? { thoughtTokens: (first.thoughtTokens ?? 0) + (second.thoughtTokens ?? 0) } : {}),
      flags: secondProblems.flags,
      attempts: 2,
      leakDetections,
    };
  } finally {
    if (leakDetections) console.warn(`[translate] output_leak detections=${leakDetections} engine=${engine.id} from=${req.from} to=${req.to} field=${req.chat ? "chat" : req.field ?? req.village ?? (req.invitationNote ? "invitation" : "body")}`);
  }
}
