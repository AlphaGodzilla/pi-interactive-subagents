/**
 * Structural views of the pi model registry, plus the reference resolution the
 * spawn path needs.
 *
 * The registry API this extension uses (`classify`, `getAvailableOfType`,
 * `getModelOfType`, ...) is newer than the pi version pinned in
 * devDependencies, so the shape is declared here instead of imported. Runtime
 * calls go to the real `ctx.modelRegistry`.
 */

export interface ClassifierModelLike {
  provider: string;
  id: string;
  name?: string;
  input?: string[];
}

export interface ChatModelLike {
  provider?: string;
  id?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

export interface ClassifierAnswerLike {
  type?: string;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  score?: number;
  probability?: number;
}

export interface ClassifierResultLike {
  provider?: string;
  model?: string;
  answers?: Record<string, ClassifierAnswerLike>;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
}

export interface ModelRegistryLike {
  classify?: (model: unknown, context: unknown, options?: unknown) => Promise<ClassifierResultLike>;
  getAvailableOfType?: (type: "classifier", provider?: string) => Promise<readonly unknown[]>;
  getModelsOfType?: (type: "classifier" | "chat", provider?: string) => readonly unknown[];
  getModelOfType?: (type: "classifier" | "chat", provider: string, modelId: string) => unknown;
  findOfType?: (type: "classifier" | "chat", provider: string, modelId: string) => unknown;
  find?: (provider: string, modelId: string) => unknown;
  /** Chat models with working credentials — what pi's own `--model` resolves against. */
  getAvailable?: () => readonly unknown[];
  /** Every known chat model, authenticated or not. */
  getAll?: () => readonly unknown[];
}

export function asChatModel(value: unknown): ChatModelLike | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const model = value as ChatModelLike;
  return typeof model.id === "string" ? model : undefined;
}

export function asClassifierModel(value: unknown): ClassifierModelLike | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const model = value as ClassifierModelLike;
  return typeof model.provider === "string" && typeof model.id === "string" ? model : undefined;
}

/**
 * Find the chat model a reference points at, so its thinking levels can be
 * clamped. Best effort: any catalog entry counts, credentials aside.
 * `reference` is a `--model` value: `provider/modelId` or a bare id.
 */
export function resolveChatModel(
  registry: ModelRegistryLike | undefined,
  reference: string,
): ChatModelLike | undefined {
  if (!registry) return undefined;

  const slash = reference.indexOf("/");
  const provider = slash > 0 ? reference.slice(0, slash) : undefined;
  const modelId = slash > 0 ? reference.slice(slash + 1) : reference;

  if (provider) {
    const direct =
      registry.getModelOfType?.("chat", provider, modelId) ??
      registry.findOfType?.("chat", provider, modelId) ??
      registry.find?.(provider, modelId);
    const found = asChatModel(direct);
    if (found) return found;
  }

  const candidates = (registry.getModelsOfType?.("chat") ?? registry.getAll?.() ?? [])
    .map(asChatModel)
    .filter((model): model is ChatEntry => model !== undefined);

  // Same ladder as pi's own `--model` resolution — canonical `provider/id`, then
  // `provider` + `id`, then a bare id — so a model id that itself contains
  // slashes (`cpa/my/gpt-6.1-sol`) resolves as well.
  const exact = findExactReference(candidates, reference);
  if (exact.kind === "match") return exact.model;

  // Short ids are accepted like pi's own `--model` resolution does, but only
  // when the match is unambiguous — a wrong guess would clamp thinking against
  // the wrong model.
  const needle = modelId.toLowerCase();
  const partial = candidates.filter(
    (model) =>
      (model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle)) &&
      (provider === undefined || model.provider === provider),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

export interface ModelTarget {
  provider?: string;
  id: string;
}

export type ModelReferenceResolution =
  | {
      ok: true;
      /** False when the registry could not be listed and the reference is passed through. */
      resolved: boolean;
      model: ModelTarget;
    }
  | { ok: false; error: string };

type ChatEntry = ChatModelLike & { id: string };
type ExactLookup =
  | { kind: "match"; model: ChatEntry }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

function modelLabel(model: ChatModelLike): string {
  return `${model.provider ?? "?"}/${model.id ?? "?"}`;
}

function listChatModels(
  registry: ModelRegistryLike | undefined,
  kind: "available" | "all",
): ChatEntry[] | undefined {
  const list = kind === "available" ? registry?.getAvailable?.() : registry?.getAll?.();
  if (!list) return undefined;
  return list.map(asChatModel).filter((model): model is ChatEntry => model !== undefined);
}

/** Exact reference match, mirroring pi's `findExactModelReferenceMatch`. */
function findExactReference(models: ChatEntry[], reference: string): ExactLookup {
  const needle = reference.trim().toLowerCase();
  if (!needle) return { kind: "none" };

  const canonical = models.filter((model) => modelLabel(model).toLowerCase() === needle);
  if (canonical.length === 1) return { kind: "match", model: canonical[0] };
  if (canonical.length > 1) return { kind: "ambiguous", candidates: canonical.map(modelLabel) };

  const slash = reference.indexOf("/");
  if (slash > 0) {
    const provider = reference.slice(0, slash).trim().toLowerCase();
    const id = reference.slice(slash + 1).trim().toLowerCase();
    const byProvider = models.filter(
      (model) => (model.provider ?? "").toLowerCase() === provider && model.id.toLowerCase() === id,
    );
    if (byProvider.length === 1) return { kind: "match", model: byProvider[0] };
    if (byProvider.length > 1) return { kind: "ambiguous", candidates: byProvider.map(modelLabel) };
  }

  const byId = models.filter((model) => model.id.toLowerCase() === needle);
  if (byId.length === 1) return { kind: "match", model: byId[0] };
  if (byId.length > 1) return { kind: "ambiguous", candidates: byId.map(modelLabel) };
  return { kind: "none" };
}

/** Substring match on id/name, preferring aliases over dated versions (pi's `tryMatchModel`). */
function findPartialMatch(models: ChatEntry[], reference: string): ChatEntry | undefined {
  const needle = reference.trim().toLowerCase();
  if (!needle) return undefined;

  const matches = models.filter(
    (model) => model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle),
  );
  if (matches.length === 0) return undefined;

  const aliases = matches.filter((model) => !/-\d{8}$/.test(model.id));
  const pool = (aliases.length > 0 ? aliases : matches).slice().sort((a, b) => b.id.localeCompare(a.id));
  return pool[0];
}

/**
 * Provider-scoped candidates for a `provider/short-id` reference, mirroring the
 * provider-prefix stripping pi's own `--model` resolution does. Falls back to
 * the full list when the prefix is not a provider in it.
 */
function scopeReference(models: ChatEntry[], reference: string): { models: ChatEntry[]; needle: string } {
  const slash = reference.indexOf("/");
  if (slash > 0) {
    const provider = reference.slice(0, slash);
    const scoped = models.filter((model) => model.provider === provider);
    if (scoped.length > 0) return { models: scoped, needle: reference.slice(slash + 1) };
  }
  return { models, needle: reference };
}

/**
 * Resolve a model string the caller wrote literally (`tool-param` / frontmatter)
 * against the model catalog, so the child pi receives an explicit
 * `--provider`/`--model` pair instead of dying on "No models match pattern".
 *
 * Accepts `provider/modelId`, a bare id, and partial/alias names (`sonnet`),
 * mirroring pi's own `--model` resolution. Ambiguous or unknown references are
 * reported as errors rather than guessed.
 */
export function resolveModelReference(
  registry: ModelRegistryLike | undefined,
  reference: string,
): ModelReferenceResolution {
  const trimmed = reference.trim();
  if (!trimmed) return { ok: false, error: "Empty model reference." };

  const available = listChatModels(registry, "available");
  if (available === undefined) {
    // A registry without a list API (older pi): keep the verbatim pass-through
    // the extension has always done and let pi resolve the reference.
    return { ok: true, resolved: false, model: { id: trimmed } };
  }

  const exact = findExactReference(available, trimmed);
  if (exact.kind === "ambiguous") {
    return {
      ok: false,
      error:
        `Model "${trimmed}" is ambiguous across providers: ${exact.candidates.join(", ")}. ` +
        "Use provider/modelId.",
    };
  }
  if (exact.kind === "match") {
    return {
      ok: true,
      resolved: true,
      model: { provider: exact.model.provider, id: exact.model.id },
    };
  }

  // pi strips a known provider prefix before fuzzy matching, so a short id
  // under a provider (`cpa_mybitx/gpt-6.1-sol` for `cpa_mybitx/mybitx/gpt-6.1-sol`)
  // resolves there too.
  const scoped = scopeReference(available, trimmed);
  const partial = findPartialMatch(scoped.models, scoped.needle);
  if (partial) {
    return { ok: true, resolved: true, model: { provider: partial.provider, id: partial.id } };
  }

  const all = listChatModels(registry, "all") ?? [];
  const scopedAll = scopeReference(all, trimmed);
  if (
    findExactReference(scopedAll.models, scopedAll.needle).kind === "match" ||
    findPartialMatch(scopedAll.models, scopedAll.needle) !== undefined
  ) {
    return {
      ok: false,
      error:
        `Model "${trimmed}" is in the catalog but its provider has no working credentials in this pi ` +
        "session. Log in (or set the API key) for that provider, or use a model from an authenticated one.",
    };
  }
  return {
    ok: false,
    error:
      `Model "${trimmed}" is not in the model catalog (searched ${available.length} available model(s)). ` +
      "Use a provider/modelId from `pi --list-models`, or a configured `modelPresets` name.",
  };
}

/**
 * `--model` target for a spawn.
 *
 * Preset references are explicit config values and pass through as written;
 * everything else is resolved against the catalog. `target` is absent when no
 * model was resolved at all (the caller inherits the parent session's model).
 */
export function resolveLaunchModelTarget(
  resolved: { source: string; model?: string },
  registry: ModelRegistryLike | undefined,
): { ok: true; target?: ModelTarget } | { ok: false; error: string } {
  const model = resolved.model;
  if (!model) return { ok: true };

  if (resolved.source.startsWith("preset:") || resolved.source.startsWith("default-preset:")) {
    return { ok: true, target: { id: model } };
  }

  const resolution = resolveModelReference(registry, model);
  if (!resolution.ok) return resolution;
  return { ok: true, target: resolution.model };
}
