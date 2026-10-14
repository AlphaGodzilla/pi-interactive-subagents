import {
  clampThinkingLevel,
  supportedThinkingLevels,
  THINKING_DECISIONS,
  THINKING_LEVELS,
  type ModelPreset,
  type ModelPresetConfig,
  type ThinkingLevelName,
} from "./model-presets.ts";
import {
  asClassifierModel,
  resolveChatModel,
  type ClassifierAnswerLike,
  type ClassifierModelLike,
  type ClassifierResultLike,
  type ModelRegistryLike,
} from "./model-registry.ts";

export interface ClassifierRef {
  provider: string;
  modelId: string;
  model: unknown;
}

export interface SubagentModelChoice {
  /** Preset the classifier picked. */
  preset: string;
  /** Model the preset points at. */
  model: string;
  /** Level to pass to `--thinking`; absent means "no opinion, use pi's default". */
  thinking?: ThinkingLevelName;
  /** Ready-to-use `subagent({ model })` value, e.g. `smart:high`. */
  modelParam: string;
  presetProbabilities: Record<string, number>;
  presetConfidence?: number;
  thinkingProbabilities?: Record<string, number>;
  thinkingConfidence?: number;
  classifier: { provider: string; modelId: string };
  /** Levels the chosen preset's model supports; absent when it is not in the catalog. */
  supportedThinkingLevels?: ThinkingLevelName[];
  /** True when the classifier's level was lowered/raised to fit the model. */
  thinkingClamped: boolean;
  /** False when the preset's model was not found in the catalog (no clamping). */
  modelResolved: boolean;
  usage?: unknown;
}

/**
 * One classifier request, as handed to a {@link ClassifierObserver} for
 * observability: what was asked, which model answered, the probabilities, what
 * was decided, how long it took, and any error.
 */
export interface ClassifierDecision {
  /** ISO timestamp of when the request finished. */
  at: string;
  /** `choose-model` = tier question, `choose-thinking` = thinking question in the tool, `thinking` = spawn-time thinking decision. */
  kind: "choose-model" | "choose-thinking" | "thinking";
  /** Absent when no classifier model could be resolved at all. */
  classifier?: { provider: string; modelId: string };
  /** The model the decision was made for, when known. */
  model?: string;
  /**
   * The exact input handed to the classifier (`task`, `agent`,
   * `agentDescription`, `model`) — without it a logged decision cannot be
   * explained after the fact.
   */
  state: Record<string, unknown>;
  /** Set when the task text was cut at the classifier input limit. */
  stateTruncated?: boolean;
  /** Question id -> what was asked (criteria keys, not their descriptions). */
  questions: Record<string, { instructions: string; criteria: string[] }>;
  /** Question id -> the answer the classifier gave. */
  answers: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
  /** What was decided (preset/thinking/modelParam/clamped, ...). */
  decision: Record<string, unknown>;
  durationMs: number;
  usage?: unknown;
  /** True on the record that completed the decision (the last of a two-call pair). */
  final?: boolean;
  error?: string;
}

/**
 * Receives every decision request. Callers use it to append the record to the
 * session log and to notify the user; it must never throw (a broken observer
 * must not break a spawn).
 */
export type ClassifierObserver = (decision: ClassifierDecision) => void;

export type ChooseSubagentModelResult =
  | { ok: true; choice: SubagentModelChoice }
  | { ok: false; error: string };

/** Longest task text handed to a classifier; the rest is dropped. */
export const MAX_CLASSIFIER_TASK_CHARS = 16_000;

/**
 * The classifier input for one request, plus whether the task had to be cut.
 * Classifiers judge a summary, not the whole artifact: a huge task prompt would
 * blow the classifier's context and cost for no extra signal.
 */
function classifierState(input: {
  task: string;
  agentName?: string;
  agentDescription?: string;
  model?: string;
  /**
   * Extra machine-readable facts the caller knows (scope, risk, deliverable,
   * agent tools, cwd, parent model, ...). Prose task text alone carries no
   * difficulty signal; these are what make the question answerable.
   */
  context?: Record<string, unknown>;
}): {
  state: Record<string, unknown>;
  truncated: boolean;
  /** Ready-to-spread decision-record fields. */
  fields: { state: Record<string, unknown>; stateTruncated?: boolean };
} {
  const state: Record<string, unknown> = { task: input.task.slice(0, MAX_CLASSIFIER_TASK_CHARS) };
  if (input.agentName) state.agent = input.agentName;
  if (input.agentDescription) state.agentDescription = input.agentDescription;
  if (input.model) state.model = input.model;
  for (const [key, value] of Object.entries(input.context ?? {})) {
    if (value !== undefined) state[key] = value;
  }
  const truncated = input.task.length > MAX_CLASSIFIER_TASK_CHARS;
  return { state, truncated, fields: { state, ...(truncated ? { stateTruncated: true } : {}) } };
}

/**
 * Built-in meaning of the three canonical tiers, used when a preset carries no
 * `description`. A `description` in config.json replaces the matching text.
 */
const CANONICAL_PRESET_CRITERIA: Record<string, string> = {
  fast: "Light, mechanical work with explicit instructions and little to reason about: lookups, formatting, cataloguing, small scripted edits. Fastest and cheapest",
  balance: "The workhorse, and where most subagent tasks belong: ordinary features, fixes, tests, reviews, refactors, routine pipeline runs. Slower than fast, far cheaper than smart",
  smart: "Heavy reasoning, design, and hard problems: bug hunting, code-vulnerability audits, cross-cutting design, debugging that needs deep analysis. Slowest and most expensive",
};

/** What each thinking level is for, shown to the classifier as its criteria. */
const THINKING_CRITERIA: Record<ThinkingLevelName, string> = {
  off: "Nothing to weigh: the answer is mechanical or already fixed by the task",
  minimal: "One trivial choice; a wrong guess shows up immediately",
  low: "Straightforward work; a mistake surfaces in the same step (a command, a test, a grep)",
  medium: "Multi-step work with a few trade-offs; mistakes usually surface while working",
  high: "Subtle correctness or invariants; a wrong answer can look right and must be verified by re-reading source",
  xhigh: "Several facts must hold at once (protocol semantics, transactions, concurrency, cross-layer wiring)",
  max: "Novel design or debugging where each extra pass of reasoning pays off",
};


/** Every classifier model in the catalog, credentials aside. */
function listClassifierModels(registry: ModelRegistryLike): ClassifierModelLike[] {
  return (registry.getModelsOfType?.("classifier") ?? [])
    .map(asClassifierModel)
    .filter((model): model is ClassifierModelLike => model !== undefined);
}

/** `Known classifier models: a/x, b/y.` — or a note that the catalog has none. */
function describeClassifierCatalog(registry: ModelRegistryLike): string {
  const known = listClassifierModels(registry);
  if (known.length === 0) {
    return "No classifier models are in this pi catalog at all — see the pi models docs, section \"Use classifier models\".";
  }
  return `Known classifier models: ${known.map((model) => `${model.provider}/${model.id}`).join(", ")}.`;
}

/** Find a classifier model by provider/id, falling back to an id match. */
function findClassifierModel(
  registry: ModelRegistryLike,
  provider: string | undefined,
  modelId: string,
): ClassifierModelLike | undefined {
  if (provider) {
    const direct =
      registry.getModelOfType?.("classifier", provider, modelId) ??
      registry.findOfType?.("classifier", provider, modelId);
    const found = asClassifierModel(direct);
    if (found) return found;
  }

  const candidates = listClassifierModels(registry);
  return candidates.find(
    (model) => model && model.id === modelId && (provider === undefined || model.provider === provider),
  );
}


/**
 * Classifier used by `subagent_choose_model`: the configured `classifierModel`
 * when set, otherwise the first classifier model with working credentials.
 */
export async function resolveClassifierModel(
  registry: ModelRegistryLike | undefined,
  configured: string | null,
): Promise<{ ok: true; ref: ClassifierRef } | { ok: false; error: string }> {
  if (typeof registry?.classify !== "function") {
    return {
      ok: false,
      error:
        "This pi build does not expose ctx.modelRegistry.classify(). " +
        "subagent_choose_model needs a pi version with classifier models.",
    };
  }

  if (configured) {
    const slash = configured.indexOf("/");
    const provider = slash > 0 ? configured.slice(0, slash) : undefined;
    const modelId = slash > 0 ? configured.slice(slash + 1) : configured;
    const model = findClassifierModel(registry, provider, modelId);
    if (!model) {
      return {
        ok: false,
        error:
          `Configured classifierModel "${configured}" is not a known classifier model. ` +
          describeClassifierCatalog(registry),
      };
    }
    return { ok: true, ref: { provider: model.provider, modelId: model.id, model } };
  }

  const available = (await registry.getAvailableOfType?.("classifier")) ?? [];
  const first = asClassifierModel(available[0]);
  if (!first) {
    return {
      ok: false,
      error:
        "No classifier model is available (no provider with classifier models has working credentials). " +
        "Authenticate one (TypeSafe Jev, Cloudflare Workers AI Clef, OpenAI Decisions — see the pi models " +
        'docs, "Use classifier models") or set "classifierModel": "provider/modelId" in config.json.',
    };
  }
  return { ok: true, ref: { provider: first.provider, modelId: first.id, model: first } };
}

/** Highest-probability label among `allowed`, or undefined when the answer is unusable. */
function pickChoice(
  answer: ClassifierAnswerLike | undefined,
  allowed: readonly string[],
): { choice: string; probabilities: Record<string, number>; confidence?: number } | undefined {
  if (!answer) return undefined;

  const probabilities: Record<string, number> = {};
  for (const [label, value] of Object.entries(answer.probabilities ?? {})) {
    if (allowed.includes(label) && typeof value === "number" && Number.isFinite(value)) {
      probabilities[label] = value;
    }
  }

  let choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!choice && answer.choice && allowed.includes(answer.choice)) choice = answer.choice;
  if (!choice) return undefined;

  return {
    choice,
    probabilities,
    ...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
  };
}

/** The thinking question, offering only the levels worth asking about. */
function thinkingQuestion(levels: readonly ThinkingLevelName[]): Record<string, unknown> {
  return {
    type: "choice",
    instructions:
      "How costly would a wrong or shallow answer be for this task, and how deep must the " +
      "verification go? Judge the task text together with the facts in `state` (scope, risk, " +
      "deliverable, agent tools, model).",
    criteria: Object.fromEntries(levels.map((level) => [level, THINKING_CRITERIA[level]])),
  };
}

const PRESET_QUESTION_INSTRUCTIONS =
  "Which model tier should handle this task? The workhorse tier is where most subagent tasks belong, so pick the " +
  "cheapest tier that can do the job and save the expensive one for the work its criteria name. If two tiers both " +
  "fit, choose the cheaper one. Weigh the task text together with the facts in `state` (scope, risk, deliverable, " +
  "agent tools): `agentDescription` describes the agent's role, not this task's difficulty, so it is not a reason " +
  "to escalate.";

/**
 * Union of the thinking levels the candidate models support, in ascending order
 * — so a model that only does `max`, or caps at `high`, is never offered a level
 * it cannot run. `undefined` when none of them is in the catalog: the caller
 * then offers every level and clamps the answer afterwards.
 */
function candidateThinkingLevels(
  registry: ModelRegistryLike | undefined,
  presets: ModelPreset[],
): ThinkingLevelName[] | undefined {
  const union = new Set<ThinkingLevelName>();
  let resolvedAny = false;

  for (const preset of presets) {
    const model = resolveChatModel(registry, preset.model);
    if (!model) continue;
    resolvedAny = true;
    for (const level of supportedThinkingLevels(model)) union.add(level);
  }

  if (!resolvedAny) return undefined;
  return THINKING_LEVELS.filter((level) => union.has(level));
}

function presetCriteria(preset: ModelPreset, name: string): string {
  return preset.description ?? CANONICAL_PRESET_CRITERIA[name] ?? `Model preset "${name}"`;
}

/** Question id -> what was asked, for the decision record. */
function describeQuestions(questions: Record<string, unknown>): ClassifierDecision["questions"] {
  const described: ClassifierDecision["questions"] = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question == null || typeof question !== "object") continue;
    const value = question as { instructions?: unknown; criteria?: unknown };
    const criteria = value.criteria != null && typeof value.criteria === "object" ? value.criteria : {};
    described[id] = {
      instructions: typeof value.instructions === "string" ? value.instructions : "",
      criteria: Object.keys(criteria as Record<string, unknown>),
    };
  }
  return described;
}

/** Question id -> the answer received, for the decision record. */
function describeAnswers(result: ClassifierResultLike | undefined): ClassifierDecision["answers"] {
  const described: ClassifierDecision["answers"] = {};
  for (const [id, answer] of Object.entries(result?.answers ?? {})) {
    described[id] = {
      ...(typeof answer?.choice === "string" ? { choice: answer.choice } : {}),
      ...(answer?.probabilities ? { probabilities: answer.probabilities } : {}),
      ...(typeof answer?.confidence === "number" ? { confidence: answer.confidence } : {}),
    };
  }
  return described;
}

/** Run one classify call, measuring it and turning every failure into a value. */
async function runClassify(input: {
  registry: ModelRegistryLike;
  model: unknown;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; result: ClassifierResultLike; durationMs: number }
  | { ok: false; result?: ClassifierResultLike; durationMs: number; error: string }
> {
  const startedAt = Date.now();
  try {
    const result = await input.registry.classify!(
      input.model,
      { state: input.state, questions: input.questions },
      { signal: input.signal },
    );
    const durationMs = Date.now() - startedAt;
    if (result?.stopReason !== "stop") {
      return {
        ok: false,
        result,
        durationMs,
        error: result?.errorMessage ?? result?.stopReason ?? "no result",
      };
    }
    return { ok: true, result, durationMs };
  } catch (error) {
    // classify() never rejects on the real registry, but a foreign/stale
    // registry implementation must not take the whole call down.
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, durationMs: Date.now() - startedAt, error: detail };
  }
}

/** Hand a record to the observer; observability must never break the caller. */
function reportDecision(observer: ClassifierObserver | undefined, decision: ClassifierDecision): void {
  if (!observer) return;
  try {
    observer(decision);
  } catch {
    // A broken observer must not fail the spawn/tool call.
  }
}

/**
 * Pick the model tier and thinking level for a subagent task.
 *
 * Two classify calls, in order:
 *   1. which configured tier fits the task (skipped when only one is configured);
 *   2. how much reasoning that tier's model needs — the criteria are generated
 *      from the **chosen model's own supported levels**, so an answer can never
 *      pair a "low" intent with a model that only does `xhigh`/`max`.
 *
 * A preset that pins `thinking` skips call 2 entirely. Every request is reported
 * to `observer`, with the last record of the pair marked `final`.
 */
export async function chooseSubagentModel(input: {
  registry?: ModelRegistryLike;
  config: ModelPresetConfig;
  agentName?: string;
  agentDescription?: string;
  task: string;
  /** Extra machine-readable facts for the classifier (scope, risk, tools, ...). */
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  observer?: ClassifierObserver;
}): Promise<ChooseSubagentModelResult> {
  const presetNames = Object.keys(input.config.presets);
  if (presetNames.length === 0) {
    return {
      ok: false,
      error:
        "No modelPresets are configured. Add a \"modelPresets\" object (fast/balance/smart, ...) " +
        "to config.json before choosing a subagent model.",
    };
  }

  const registry = input.registry as ModelRegistryLike;

  // Built before the classifier is resolved so a failed request still records
  // exactly what would have been asked, and with which input.
  const tierState = classifierState({
    task: input.task,
    agentName: input.agentName,
    agentDescription: input.agentDescription,
    context: input.context,
  });
  const presetQuestion =
    presetNames.length > 1
      ? {
          type: "choice",
          instructions: PRESET_QUESTION_INSTRUCTIONS,
          criteria: Object.fromEntries(
            presetNames.map((name) => [name, presetCriteria(input.config.presets[name], name)]),
          ),
        }
      : undefined;

  const resolved = await resolveClassifierModel(input.registry, input.config.classifierModel);
  if (!resolved.ok) {
    reportDecision(input.observer, {
      at: new Date().toISOString(),
      kind: "choose-model",
      ...tierState.fields,
      questions: describeQuestions(presetQuestion ? { preset: presetQuestion } : {}),
      answers: {},
      decision: {},
      durationMs: 0,
      final: true,
      error: resolved.error,
    });
    return resolved;
  }
  const { ref } = resolved;
  const who = `${ref.provider}/${ref.modelId}`;

  // ── Call 1: which tier ──
  let presetPick:
    | { choice: string; probabilities: Record<string, number>; confidence?: number }
    | undefined =
    presetNames.length === 1
      ? { choice: presetNames[0], probabilities: {} }
      : undefined;
  let tierResult: ClassifierResultLike | undefined;
  let tierDurationMs = 0;

  if (presetQuestion) {
    const outcome = await runClassify({
      registry,
      model: ref.model,
      state: tierState.state,
      questions: { preset: presetQuestion },
      signal: input.signal,
    });
    tierDurationMs = outcome.durationMs;
    tierResult = outcome.result;

    if (!outcome.ok) {
      reportDecision(input.observer, {
        at: new Date().toISOString(),
        kind: "choose-model",
        classifier: { provider: ref.provider, modelId: ref.modelId },
        ...tierState.fields,
        questions: describeQuestions({ preset: presetQuestion }),
        answers: describeAnswers(outcome.result),
        decision: {},
        durationMs: tierDurationMs,
        ...(outcome.result?.usage !== undefined ? { usage: outcome.result.usage } : {}),
        final: true,
        error: outcome.error,
      });
      return { ok: false, error: `Classifier ${who} failed: ${outcome.error}` };
    }

    presetPick = pickChoice(outcome.result.answers?.preset, presetNames);
    if (!presetPick) {
      const error = `Classifier ${who} returned no usable preset answer.`;
      reportDecision(input.observer, {
        at: new Date().toISOString(),
        kind: "choose-model",
        classifier: { provider: ref.provider, modelId: ref.modelId },
        ...tierState.fields,
        questions: describeQuestions({ preset: presetQuestion }),
        answers: describeAnswers(tierResult),
        decision: {},
        durationMs: tierDurationMs,
        final: true,
        error,
      });
      return { ok: false, error };
    }
  }

  // Unreachable: a single preset is taken directly and the tier call above
  // either answered or already returned an error.
  if (!presetPick) {
    return { ok: false, error: `Classifier ${who} returned no usable preset answer.` };
  }

  const preset = input.config.presets[presetPick.choice];
  const policy = preset.thinking ?? THINKING_DECISIONS;

  // The concrete model the chosen tier points at decides which levels call 2 may
  // offer. No catalog entry means no way to narrow them down, so every level is
  // offered (and nothing is clamped).
  const chatModel = resolveChatModel(registry, preset.model);
  const supported = chatModel ? supportedThinkingLevels(chatModel) : undefined;
  const levels = supported ?? [...THINKING_LEVELS];

  const askThinking = policy === THINKING_DECISIONS && levels.length > 1;
  // A single supported level needs no question. "off" alone means there is no
  // reasoning to configure, so it stays unset.
  const pinnedRequest =
    policy !== THINKING_DECISIONS ? (policy as ThinkingLevelName) : levels.length === 1 && levels[0] !== "off" ? levels[0] : undefined;
  const pinnedThinking = pinnedRequest
    ? chatModel
      ? clampThinkingLevel(chatModel, pinnedRequest)
      : pinnedRequest
    : undefined;

  // The tier record: `final` only when no thinking call follows it.
  if (presetQuestion) {
    reportDecision(input.observer, {
      at: new Date().toISOString(),
      kind: "choose-model",
      classifier: { provider: ref.provider, modelId: ref.modelId },
      model: preset.model,
      ...tierState.fields,
      questions: describeQuestions({ preset: presetQuestion }),
      answers: describeAnswers(tierResult),
      decision: {
        preset: presetPick.choice,
        model: preset.model,
        policy,
        ...(pinnedThinking ? { thinking: pinnedThinking } : {}),
      },
      durationMs: tierDurationMs,
      ...(tierResult?.usage !== undefined ? { usage: tierResult.usage } : {}),
      final: !askThinking,
    });
  }

  // ── Call 2: how much thinking, for the model that just won ──
  const thinkingState = classifierState({
    task: input.task,
    agentName: input.agentName,
    agentDescription: input.agentDescription,
    model: preset.model,
    context: input.context,
  });
  const thinkingQuestions = askThinking ? { thinking: thinkingQuestion(levels) } : {};

  let thinkingResult: ClassifierResultLike | undefined;
  let thinkingDurationMs = 0;
  let thinkingPick: ReturnType<typeof pickChoice>;
  let requested = pinnedRequest;

  if (askThinking) {
    const outcome = await runClassify({
      registry,
      model: ref.model,
      state: thinkingState.state,
      questions: thinkingQuestions,
      signal: input.signal,
    });
    thinkingDurationMs = outcome.durationMs;
    thinkingResult = outcome.result;

    if (!outcome.ok) {
      const error = `Classifier ${who} failed: ${outcome.error}`;
      reportDecision(input.observer, {
        at: new Date().toISOString(),
        kind: "choose-thinking",
        classifier: { provider: ref.provider, modelId: ref.modelId },
        model: preset.model,
        ...thinkingState.fields,
        questions: describeQuestions(thinkingQuestions),
        answers: describeAnswers(outcome.result),
        decision: {},
        durationMs: thinkingDurationMs,
        ...(outcome.result?.usage !== undefined ? { usage: outcome.result.usage } : {}),
        final: true,
        error: outcome.error,
      });
      return { ok: false, error };
    }

    thinkingPick = pickChoice(outcome.result.answers?.thinking, levels);
    if (!thinkingPick) {
      const error = `Classifier ${who} returned no usable thinking answer.`;
      reportDecision(input.observer, {
        at: new Date().toISOString(),
        kind: "choose-thinking",
        classifier: { provider: ref.provider, modelId: ref.modelId },
        model: preset.model,
        ...thinkingState.fields,
        questions: describeQuestions(thinkingQuestions),
        answers: describeAnswers(thinkingResult),
        decision: {},
        durationMs: thinkingDurationMs,
        final: true,
        error,
      });
      return { ok: false, error };
    }
    requested = thinkingPick.choice as ThinkingLevelName;
  }

  const thinking = requested
    ? chatModel
      ? clampThinkingLevel(chatModel, requested)
      : requested
    : undefined;
  const thinkingClamped = requested !== undefined && thinking !== undefined && thinking !== requested;

  if (askThinking) {
    reportDecision(input.observer, {
      at: new Date().toISOString(),
      kind: "choose-thinking",
      classifier: { provider: ref.provider, modelId: ref.modelId },
      model: preset.model,
      ...thinkingState.fields,
      questions: describeQuestions(thinkingQuestions),
      answers: describeAnswers(thinkingResult),
      decision: {
        preset: presetPick.choice,
        model: preset.model,
        modelParam: thinking ? `${presetPick.choice}:${thinking}` : presetPick.choice,
        ...(thinking ? { thinking } : {}),
        ...(requested && requested !== thinking ? { requested } : {}),
        clamped: thinkingClamped,
        policy,
        candidates: levels,
      },
      durationMs: thinkingDurationMs,
      ...(thinkingResult?.usage !== undefined ? { usage: thinkingResult.usage } : {}),
      final: true,
    });
  }

  return {
    ok: true,
    choice: {
      preset: presetPick.choice,
      model: preset.model,
      ...(thinking ? { thinking } : {}),
      modelParam: thinking ? `${presetPick.choice}:${thinking}` : presetPick.choice,
      presetProbabilities: presetPick.probabilities,
      ...(presetPick.confidence !== undefined ? { presetConfidence: presetPick.confidence } : {}),
      ...(thinkingPick?.probabilities ? { thinkingProbabilities: thinkingPick.probabilities } : {}),
      ...(thinkingPick?.confidence !== undefined ? { thinkingConfidence: thinkingPick.confidence } : {}),
      classifier: { provider: ref.provider, modelId: ref.modelId },
      ...(supported ? { supportedThinkingLevels: supported } : {}),
      thinkingClamped,
      modelResolved: chatModel !== undefined,
      ...((thinkingResult ?? tierResult)?.usage !== undefined
        ? { usage: thinkingResult?.usage ?? tierResult?.usage }
        : {}),
    },
  };
}


export type ChooseThinkingLevelResult =
  | {
      ok: true;
      /** Absent when there was nothing to choose (see `skipped`). */
      thinking?: ThinkingLevelName;
      /** Set when the call was skipped without asking the classifier. */
      skipped?: "model-has-no-reasoning";
      /** Levels the question offered (the model's own supported set). */
      supportedThinkingLevels?: ThinkingLevelName[];
      probabilities?: Record<string, number>;
      confidence?: number;
      classifier?: { provider: string; modelId: string };
      usage?: unknown;
    }
  | { ok: false; error: string };

/**
 * Pick a thinking level for a spawn that does not pin a model — the child
 * inherits the parent session's model, so only the reasoning effort is open.
 *
 * The question only offers levels that model actually supports, so the answer
 * never needs clamping: a model that only does `max`, or caps at `high`, is
 * asked exactly that. A model with no extended reasoning is not worth a
 * classifier call, and a single supported level is used directly.
 */
export async function chooseThinkingLevel(input: {
  registry?: ModelRegistryLike;
  config: ModelPresetConfig;
  agentName?: string;
  agentDescription?: string;
  task: string;
  /** The model the child will run on; decides which levels are offered. */
  model?: { provider?: string; id?: string };
  /** Extra machine-readable facts for the classifier (scope, risk, tools, ...). */
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  observer?: ClassifierObserver;
}): Promise<ChooseThinkingLevelResult> {
  const reference = input.model?.id
    ? input.model.provider
      ? `${input.model.provider}/${input.model.id}`
      : input.model.id
    : undefined;
  const chatModel = reference ? resolveChatModel(input.registry, reference) : undefined;

  if (chatModel && chatModel.reasoning !== true) {
    return { ok: true, skipped: "model-has-no-reasoning" };
  }

  const supported = chatModel ? supportedThinkingLevels(chatModel) : undefined;
  const levels = supported ?? [...THINKING_LEVELS];

  // Nothing to decide: the model has exactly one supported level.
  if (levels.length === 1) {
    return {
      ok: true,
      thinking: levels[0],
      ...(supported ? { supportedThinkingLevels: supported } : {}),
    };
  }

  const questions = { thinking: thinkingQuestion(levels) };

  // Built before the classifier is resolved so a failed request still records
  // what would have been asked, and with which input.
  const inputState = classifierState({
    task: input.task,
    agentName: input.agentName,
    agentDescription: input.agentDescription,
    model: reference,
    context: input.context,
  });
  const stateFields = inputState.fields;

  const resolved = await resolveClassifierModel(input.registry, input.config.classifierModel);
  if (!resolved.ok) {
    reportDecision(input.observer, {
      at: new Date().toISOString(),
      kind: "thinking",
      ...(reference ? { model: reference } : {}),
      ...stateFields,
      questions: describeQuestions(questions),
      answers: {},
      decision: {},
      durationMs: 0,
      final: true,
      error: resolved.error,
    });
    return resolved;
  }

  const registry = input.registry as ModelRegistryLike;
  const { ref } = resolved;

  const outcome = await runClassify({
    registry,
    model: ref.model,
    state: inputState.state,
    questions,
    signal: input.signal,
  });
  if (!outcome.ok) {
    const error = `Classifier ${ref.provider}/${ref.modelId} failed: ${outcome.error}`;
    reportDecision(input.observer, {
      at: new Date().toISOString(),
      kind: "thinking",
      classifier: { provider: ref.provider, modelId: ref.modelId },
      ...(reference ? { model: reference } : {}),
      ...stateFields,
      questions: describeQuestions(questions),
      answers: describeAnswers(outcome.result),
      decision: {},
      durationMs: outcome.durationMs,
      ...(outcome.result?.usage !== undefined ? { usage: outcome.result.usage } : {}),
      final: true,
      error: outcome.error,
    });
    return { ok: false, error };
  }
  const result = outcome.result;

  const pick = pickChoice(result.answers?.thinking, levels);
  if (!pick) {
    const error = `Classifier ${ref.provider}/${ref.modelId} returned no usable thinking answer.`;
    reportDecision(input.observer, {
      at: new Date().toISOString(),
      kind: "thinking",
      classifier: { provider: ref.provider, modelId: ref.modelId },
      ...(reference ? { model: reference } : {}),
      ...stateFields,
      questions: describeQuestions(questions),
      answers: describeAnswers(result),
      decision: {},
      durationMs: outcome.durationMs,
      ...(result?.usage !== undefined ? { usage: result.usage } : {}),
      final: true,
      error,
    });
    return { ok: false, error };
  }

  // The criteria were already restricted to `levels`, so no clamping is needed.
  const thinking = pick.choice as ThinkingLevelName;

  reportDecision(input.observer, {
    at: new Date().toISOString(),
    kind: "thinking",
    classifier: { provider: ref.provider, modelId: ref.modelId },
    ...(reference ? { model: reference } : {}),
    ...stateFields,
    questions: describeQuestions(questions),
    answers: describeAnswers(result),
    decision: {
      thinking,
      ...(reference ? { model: reference } : {}),
      clamped: false,
    },
    durationMs: outcome.durationMs,
    ...(result?.usage !== undefined ? { usage: result.usage } : {}),
    final: true,
  });

  return {
    ok: true,
    thinking,
    ...(supported ? { supportedThinkingLevels: supported } : {}),
    probabilities: pick.probabilities,
    ...(pick.confidence !== undefined ? { confidence: pick.confidence } : {}),
    classifier: { provider: ref.provider, modelId: ref.modelId },
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}
