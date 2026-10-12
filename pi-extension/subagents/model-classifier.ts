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

export type ChooseSubagentModelResult =
  | { ok: true; choice: SubagentModelChoice }
  | { ok: false; error: string };

/** Longest task text handed to a classifier; the rest is dropped. */
export const MAX_CLASSIFIER_TASK_CHARS = 16_000;

/**
 * Built-in meaning of the three canonical tiers, used when a preset carries no
 * `description`. A `description` in config.json replaces the matching text.
 */
const CANONICAL_PRESET_CRITERIA: Record<string, string> = {
  fast: "Quick, cheap work: reconnaissance, lookups, formatting, small mechanical edits",
  balance: "Everyday implementation: ordinary features, fixes, tests, reviews, refactors",
  smart: "Demanding work: subtle design, hard debugging, cross-cutting changes, architecture",
};

/** What each thinking level is for, shown to the classifier as its criteria. */
const THINKING_CRITERIA: Record<ThinkingLevelName, string> = {
  off: "No extended reasoning — mechanical work with nothing to weigh",
  minimal: "A trace of reasoning — trivial decisions",
  low: "Light reasoning — straightforward work with a few small choices",
  medium: "Moderate reasoning — multi-step work with trade-offs",
  high: "Heavy reasoning — subtle correctness, design, or debugging",
  xhigh: "Very heavy reasoning — only the hardest problems",
  max: "Maximum reasoning budget — rare and expensive",
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
    instructions: "How much extended reasoning effort does this subagent task need?",
    criteria: Object.fromEntries(levels.map((level) => [level, THINKING_CRITERIA[level]])),
  };
}

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

/**
 * Classify a subagent task into a preset + thinking level, then clamp the level
 * to what the preset's model actually supports.
 *
 * One classify call asks both questions; the thinking answer is resolved against
 * the concrete model afterwards, so `model: "smart:high"` never asks for a level
 * the chosen model cannot do.
 */
export async function chooseSubagentModel(input: {
  registry?: ModelRegistryLike;
  config: ModelPresetConfig;
  agentName?: string;
  agentDescription?: string;
  task: string;
  signal?: AbortSignal;
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

  const resolved = await resolveClassifierModel(input.registry, input.config.classifierModel);
  if (!resolved.ok) return resolved;

  const registry = input.registry as ModelRegistryLike;
  const { ref } = resolved;

  // Presets that pin a thinking level never need the question — the configured
  // level is used as is. Only the presets that defer to the classifier
  // ("decisions", the default) contribute candidates.
  const decidingPresets = presetNames
    .map((name) => input.config.presets[name])
    .filter((preset) => (preset.thinking ?? THINKING_DECISIONS) === THINKING_DECISIONS);

  // Which thinking levels are worth asking about: the union of what those
  // candidate models support, so a model that only does `max` (or caps at
  // `high`) is never offered a level it cannot run. `undefined` means none of
  // them is in the catalog, so every level is offered and the answer is clamped
  // afterwards.
  const candidates = candidateThinkingLevels(registry, decidingPresets);
  const levels = candidates ?? [...THINKING_LEVELS];
  const askThinking = decidingPresets.length > 0 && levels.length > 1;
  // A single supported level needs no question. "off" alone means there is no
  // reasoning to configure, so it stays unset.
  const onlyLevel =
    decidingPresets.length > 0 && levels.length === 1 && levels[0] !== "off" ? levels[0] : undefined;

  const questions: Record<string, unknown> = {};
  if (presetNames.length > 1) {
    questions.preset = {
      type: "choice",
      instructions: "Which model tier should handle this subagent task?",
      criteria: Object.fromEntries(
        presetNames.map((name) => [name, presetCriteria(input.config.presets[name], name)]),
      ),
    };
  }
  if (askThinking) questions.thinking = thinkingQuestion(levels);

  // Nothing to ask (a single preset whose model has a single supported level):
  // the decision is already determined, so skip the classifier call entirely —
  // classify() expects at least one question.
  let result: ClassifierResultLike | undefined;
  if (Object.keys(questions).length > 0) {
    // Classifiers judge a summary, not the whole artifact: a huge task prompt
    // would blow the classifier's context and cost for no extra signal.
    const state: Record<string, unknown> = { task: input.task.slice(0, MAX_CLASSIFIER_TASK_CHARS) };
    if (input.agentName) state.agent = input.agentName;
    if (input.agentDescription) state.agentDescription = input.agentDescription;

    try {
      result = await registry.classify!(ref.model, { state, questions }, { signal: input.signal });
    } catch (error) {
      // classify() never rejects on the real registry, but a foreign/stale
      // registry implementation must not take the whole tool call down.
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Classifier ${ref.provider}/${ref.modelId} call failed: ${detail}` };
    }

    if (result?.stopReason !== "stop") {
      const detail = result?.errorMessage ?? result?.stopReason ?? "no result";
      return { ok: false, error: `Classifier ${ref.provider}/${ref.modelId} failed: ${detail}` };
    }
  }

  const presetPick =
    presetNames.length === 1
      ? { choice: presetNames[0], probabilities: {}, confidence: undefined }
      : pickChoice(result?.answers?.preset, presetNames);
  if (!presetPick) {
    return {
      ok: false,
      error: `Classifier ${ref.provider}/${ref.modelId} returned no usable preset answer.`,
    };
  }

  const preset = input.config.presets[presetPick.choice];
  const policy = preset.thinking ?? THINKING_DECISIONS;

  // The concrete model the preset points at decides the supported levels and
  // clamps a classified answer (the question may have offered the union across
  // presets, so the answer can still sit outside what this model supports).
  const chatModel = resolveChatModel(registry, preset.model);
  const supported = chatModel ? supportedThinkingLevels(chatModel) : undefined;

  // A configured level is used as is — the classifier is never asked about it.
  const thinkingPick = askThinking ? pickChoice(result?.answers?.thinking, levels) : undefined;
  const requested =
    policy === THINKING_DECISIONS
      ? ((thinkingPick?.choice as ThinkingLevelName | undefined) ?? onlyLevel)
      : (policy as ThinkingLevelName);
  // Without a catalog entry there is nothing to clamp against.
  const thinking = requested ? (chatModel ? clampThinkingLevel(chatModel, requested) : requested) : undefined;
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
      thinkingClamped: requested !== undefined && thinking !== undefined && thinking !== requested,
      modelResolved: chatModel !== undefined,
      ...(result?.usage !== undefined ? { usage: result.usage } : {}),
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
  signal?: AbortSignal;
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

  const resolved = await resolveClassifierModel(input.registry, input.config.classifierModel);
  if (!resolved.ok) return resolved;


  const registry = input.registry as ModelRegistryLike;
  const { ref } = resolved;

  const state: Record<string, unknown> = { task: input.task.slice(0, MAX_CLASSIFIER_TASK_CHARS) };
  if (input.agentName) state.agent = input.agentName;
  if (input.agentDescription) state.agentDescription = input.agentDescription;
  if (reference) state.model = reference;

  let result: ClassifierResultLike;
  try {
    result = await registry.classify!(
      ref.model,
      {
        state,
        questions: { thinking: thinkingQuestion(levels) },
      },
      { signal: input.signal },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Classifier ${ref.provider}/${ref.modelId} call failed: ${detail}` };
  }

  if (result?.stopReason !== "stop") {
    const detail = result?.errorMessage ?? result?.stopReason ?? "no result";
    return { ok: false, error: `Classifier ${ref.provider}/${ref.modelId} failed: ${detail}` };
  }

  const pick = pickChoice(result.answers?.thinking, levels);
  if (!pick) {
    return { ok: false, error: `Classifier ${ref.provider}/${ref.modelId} returned no usable thinking answer.` };
  }

  // The criteria were already restricted to `levels`, so no clamping is needed.
  const thinking = pick.choice as ThinkingLevelName;

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
