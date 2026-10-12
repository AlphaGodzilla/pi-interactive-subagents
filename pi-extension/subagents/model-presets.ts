import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentConfigDir } from "./pi-command.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The three canonical model tiers. They are ordinary preset names — the
 * extension only treats them specially for a spawn-time typo warning — but
 * documenting them keeps every config in a project speaking the same
 * vocabulary.
 */
export const CANONICAL_MODEL_PRESETS = ["fast", "balance", "smart"] as const;

/** Directory (relative to a config root) that holds this extension's standalone config. */
const EXTENSION_CONFIG_DIR = join("extensions", "pi-interactive-subagents");

/**
 * Tolerated misspelling of the extensions directory. Users type
 * `.pi/extentions/...` often enough that silently ignoring the file would be
 * indistinguishable from "the feature does not work".
 */
const EXTENSION_CONFIG_DIR_LEGACY = join("extentions", "pi-interactive-subagents");

export interface ModelPreset {
  /** Model id/pattern passed to `--model`, e.g. `anthropic/claude-sonnet-4-5` or a `pi` pattern. */
  model: string;
  /** What this tier is for. Used as the classifier criteria in `subagent_choose_model`. */
  description?: string;
  /**
   * Thinking policy for this tier: a fixed level, or `"decisions"` to let the
   * classifier pick one per task. Unset means `"decisions"`.
   */
  thinking?: PresetThinking;
}

/**
 * Thinking levels pi accepts for `--thinking`, in ascending effort order. The
 * order is load-bearing: clamping walks it.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevelName {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Preset `thinking` value that defers the choice to the classifier model. */
export const THINKING_DECISIONS = "decisions";

/** A preset's thinking policy: a fixed level, or `"decisions"`. */
export type PresetThinking = ThinkingLevelName | typeof THINKING_DECISIONS;

export function isPresetThinking(value: string): value is PresetThinking {
  return value === THINKING_DECISIONS || isThinkingLevel(value);
}

/**
 * Split a trailing `:<thinking>` suffix, mirroring pi's own
 * `--model <pattern>:<level>` shorthand. Only a valid level is stripped, so a
 * model id like `openrouter/x:exacto` stays intact.
 */
export function splitThinkingSuffix(value: string | undefined): {
  base: string | undefined;
  thinking: ThinkingLevelName | undefined;
} {
  const trimmed = trimToUndefined(value);
  if (!trimmed) return { base: undefined, thinking: undefined };

  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) return { base: trimmed, thinking: undefined };

  const suffix = trimmed.slice(colon + 1);
  if (!isThinkingLevel(suffix)) return { base: trimmed, thinking: undefined };

  return { base: trimmed.slice(0, colon), thinking: suffix };
}

/** The slice of a chat model that decides which thinking levels it supports. */
export interface ThinkingCapableModel {
  reasoning?: boolean;
  /** `null` marks a level as unsupported; missing keys use provider defaults. */
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

/**
 * Levels a model actually supports — a local mirror of pi's own
 * `getSupportedThinkingLevels`, so the extension does not depend on the
 * installed pi-ai internals.
 */
export function supportedThinkingLevels(model: ThinkingCapableModel | undefined): ThinkingLevelName[] {
  if (!model || model.reasoning !== true) return ["off"];

  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * Clamp a requested level to what the model supports, preferring a higher level
 * over a lower one (mirrors pi's `clampThinkingLevel`). No request yields the
 * model's first supported level.
 */
export function clampThinkingLevel(
  model: ThinkingCapableModel | undefined,
  requested: string | undefined,
): ThinkingLevelName {
  const available = supportedThinkingLevels(model);
  const level = requested && isThinkingLevel(requested) ? requested : undefined;
  if (!level) return available[0] ?? "off";
  if (available.includes(level)) return level;

  const index = THINKING_LEVELS.indexOf(level);
  for (let i = index; i < THINKING_LEVELS.length; i++) {
    if (available.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  for (let i = index - 1; i >= 0; i--) {
    if (available.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  return available[0] ?? "off";
}

export interface ModelPresetConfig {
  /** Preset name -> model, merged across every config layer. */
  presets: Record<string, ModelPreset>;
  /** Preset applied to agents that do not select one. `null` when unset. */
  defaultPreset: string | null;
  /**
   * Classifier model used by `subagent_choose_model`, as `"provider/modelId"`.
   * `null` means "use the first available classifier model".
   */
  classifierModel: string | null;
  /** Config files that contributed to this result, in ascending priority order. */
  sources: string[];
}

export interface ResolvedSubagentModel {
  /**
   * Model string for `--model`. `undefined` means "no model resolved" — the
   * caller inherits the parent session's current model.
   */
  model?: string;
  /**
   * Fixed thinking level for `--thinking`, from the `model` parameter's
   * `:<level>` suffix, frontmatter `thinking`, the frontmatter `model` suffix,
   * or the active preset's `thinking`. Absent when the level is left to the
   * classifier (see `decideThinking`). Frontmatter values pass through as
   * written — pi warns about a level it does not know.
   */
  thinking?: string;
  /** Where the model came from: `tool-param`, `frontmatter`, `preset:<name>`, `default-preset:<name>`, `unresolved`. */
  source: string;
  /** Preset that contributed the model, when any. */
  preset?: string;
  /**
   * True when nothing pinned a level and the classifier must pick one for this
   * task: the active preset says `"decisions"` (or omits `thinking`), or no
   * model was resolved at all and the child inherits the parent session's.
   */
  decideThinking: boolean;
  /** Human-readable warning for a silently-unresolvable preset reference. */
  warning?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function invalid(source: string, detail: string): never {
  throw new Error(`Invalid subagent config ${source}: ${detail}`);
}

/**
 * Config files consulted for `modelPresets`, in ASCENDING priority order (each
 * later file is deep-merged over the previous ones):
 *
 *   1. the extension's own `config.json` (bundled defaults)
 *   2. `$PI_CODING_AGENT_DIR/extentions/pi-interactive-subagents/config.json` (legacy spelling)
 *   3. `$PI_CODING_AGENT_DIR/extensions/pi-interactive-subagents/config.json` (global)
 *   4. `<cwd>/.pi/extentions/pi-interactive-subagents/config.json` (legacy spelling)
 *   5. `<cwd>/.pi/extensions/pi-interactive-subagents/config.json` (project)
 */
export function modelPresetConfigPaths(
  options: {
    cwd?: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
  } = {},
): string[] {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentConfigDir(options.env ?? process.env);
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;

  return [
    ...new Set([
      join(packageRoot, "config.json"),
      join(agentDir, EXTENSION_CONFIG_DIR_LEGACY, "config.json"),
      join(agentDir, EXTENSION_CONFIG_DIR, "config.json"),
      join(cwd, ".pi", EXTENSION_CONFIG_DIR_LEGACY, "config.json"),
      join(cwd, ".pi", EXTENSION_CONFIG_DIR, "config.json"),
    ]),
  ];
}

/**
 * Recursively merge `overlay` over `base`. Plain objects merge key by key;
 * arrays and scalars are replaced wholesale (a later `null` clears a key).
 */
export function mergeConfigObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key];
    merged[key] =
      isPlainObject(previous) && isPlainObject(value) ? mergeConfigObjects(previous, value) : value;
  }
  return merged;
}

/**
 * Read one config file. Missing files yield `null`; malformed JSON or a
 * non-object root throws so a typo is never silently ignored.
 */
export function readModelPresetConfigFile(configPath: string): Record<string, unknown> | null {
  let rawConfig: string;
  try {
    rawConfig = readFileSync(configPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${configPath}: ${detail}`);
  }

  if (!isPlainObject(parsed)) return invalid(configPath, "root must be an object");
  return parsed;
}

/**
 * Validate the merged `modelPresets`/`defaultPreset` keys of a config object.
 * Unrelated top-level keys (`status`, `piBin`, ...) are ignored — the same
 * file carries all extension settings.
 */
export function parseModelPresetConfig(raw: unknown, sources: string[] = []): ModelPresetConfig {
  const source = sources.length > 0 ? sources.join(" + ") : "config.json";
  if (!isPlainObject(raw)) invalid(source, "root must be an object");

  const presets: Record<string, ModelPreset> = {};
  const rawPresets = raw.modelPresets;
  if (rawPresets !== undefined) {
    if (!isPlainObject(rawPresets)) invalid(source, "modelPresets must be an object");

    for (const [name, value] of Object.entries(rawPresets)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        invalid(
          source,
          `modelPresets key "${name}" must start with a lowercase letter and contain only lowercase letters, digits, "-" or "_"`,
        );
      }

      // Shorthand: "fast": "anthropic/claude-haiku-4-5".
      if (typeof value === "string") {
        const model = value.trim();
        if (!model) invalid(source, `modelPresets.${name} must be a non-empty string or an object`);
        presets[name] = { model };
        continue;
      }

      if (!isPlainObject(value)) invalid(source, `modelPresets.${name} must be a string or an object`);

      // Presets carry a model, an optional classifier-facing description, and an
      // optional thinking policy (a fixed level, or "decisions").
      const unsupported = Object.keys(value).filter(
        (key) => key !== "model" && key !== "description" && key !== "thinking",
      );
      if (unsupported.length > 0) {
        invalid(source, `modelPresets.${name} has unsupported key(s): ${unsupported.join(", ")}`);
      }

      const model = typeof value.model === "string" ? value.model.trim() : "";
      if (!model) invalid(source, `modelPresets.${name}.model must be a non-empty string`);

      const description = trimToUndefined(
        typeof value.description === "string" ? value.description : undefined,
      );
      if (value.description !== undefined && !description) {
        invalid(source, `modelPresets.${name}.description must be a non-empty string`);
      }

      const thinkingValue = trimToUndefined(
        typeof value.thinking === "string" ? value.thinking : undefined,
      );
      if (value.thinking !== undefined && (!thinkingValue || !isPresetThinking(thinkingValue))) {
        invalid(
          source,
          `modelPresets.${name}.thinking must be ${THINKING_LEVELS.join(", ")} or "${THINKING_DECISIONS}"`,
        );
      }
      const thinking = thinkingValue && isPresetThinking(thinkingValue) ? thinkingValue : undefined;

      presets[name] = {
        model,
        ...(description ? { description } : {}),
        ...(thinking ? { thinking } : {}),
      };
    }
  }

  let defaultPreset: string | null = null;
  if (raw.defaultPreset !== undefined && raw.defaultPreset !== null) {
    if (typeof raw.defaultPreset !== "string" || !raw.defaultPreset.trim()) {
      invalid(source, "defaultPreset must be a non-empty string");
    }
    defaultPreset = raw.defaultPreset.trim();
    if (!(defaultPreset in presets)) {
      invalid(source, `defaultPreset "${defaultPreset}" is not defined in modelPresets`);
    }
  }

  let classifierModel: string | null = null;
  if (raw.classifierModel !== undefined && raw.classifierModel !== null) {
    if (typeof raw.classifierModel !== "string" || !raw.classifierModel.trim()) {
      invalid(source, 'classifierModel must be a non-empty "provider/modelId" string');
    }
    classifierModel = raw.classifierModel.trim();
  }

  return { presets, defaultPreset, classifierModel, sources: [...sources] };
}

/**
 * Load and deep-merge every config layer. Returns an empty config when no
 * file exists; throws on malformed content.
 */
export function loadModelPresetConfig(
  options: {
    configPaths?: string[];
    cwd?: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
  } = {},
): ModelPresetConfig {
  const configPaths = options.configPaths ?? modelPresetConfigPaths(options);

  const sources: string[] = [];
  let merged: Record<string, unknown> = {};
  for (const configPath of configPaths) {
    const parsed = readModelPresetConfigFile(configPath);
    if (!parsed) continue;
    merged = mergeConfigObjects(merged, parsed);
    sources.push(configPath);
  }

  return parseModelPresetConfig(merged, sources);
}

/** Look up a preset by exact name. */
export function getModelPreset(
  config: ModelPresetConfig,
  name: string | undefined,
): ModelPreset | undefined {
  const trimmed = trimToUndefined(name);
  return trimmed ? config.presets[trimmed] : undefined;
}

/**
 * Resolve the model + thinking level for one spawn.
 *
 * The model comes from the highest-priority layer that carries one, with any
 * value that names a configured preset expanded to that preset's model:
 *
 *   1. `paramModel` — the `subagent({ model })` tool parameter, with an
 *      optional `:<thinking>` suffix (`"smart:high"`). A value whose base names
 *      a configured preset expands to that preset, anything else is a literal
 *      model id.
 *   2. agent frontmatter `model` — same preset/literal and `:<thinking>` rule.
 *   3. `defaultPreset` from config.
 *   4. nothing — the caller inherits the parent session's model.
 * The thinking level is resolved separately, highest first: the `model`
 * parameter's `:<level>` suffix, frontmatter `thinking`, then the frontmatter
 * `model` suffix. When none of those pin a level, the active preset's
 * `thinking` decides: a fixed level, or `"decisions"` (also the default when the
 * preset omits it) which sets `decideThinking` so the caller asks the classifier.
 * With no preset at all, only an inherited model leaves the level open.
 */
export function resolveSubagentModel(input: {
  config: ModelPresetConfig;
  agentName?: string;
  paramModel?: string;
  frontmatterModel?: string;
  frontmatterThinking?: string;
}): ResolvedSubagentModel {
  const param = splitThinkingSuffix(input.paramModel);
  const frontmatter = splitThinkingSuffix(input.frontmatterModel);
  const frontmatterThinking = trimToUndefined(input.frontmatterThinking);

  const paramModel = param.base;
  const frontmatterModel = frontmatter.base;
  const paramPresetName = getModelPreset(input.config, paramModel) ? paramModel : undefined;
  const frontmatterPresetName = getModelPreset(input.config, frontmatterModel) ? frontmatterModel : undefined;
  const defaultPresetName = getModelPreset(input.config, input.config.defaultPreset ?? undefined)
    ? (input.config.defaultPreset as string)
    : undefined;

  const activePresetName = paramPresetName ?? frontmatterPresetName ?? defaultPresetName;
  const activePreset = activePresetName ? input.config.presets[activePresetName] : undefined;

  let model: string | undefined;
  let source = "unresolved";

  if (paramPresetName && activePreset) {
    model = activePreset.model;
    source = `preset:${paramPresetName}`;
  } else if (paramModel) {
    model = paramModel;
    source = "tool-param";
  } else if (frontmatterPresetName && activePreset) {
    model = activePreset.model;
    source = `preset:${frontmatterPresetName}`;
  } else if (frontmatterModel) {
    model = frontmatterModel;
    source = "frontmatter";
  } else if (defaultPresetName && activePreset) {
    model = activePreset.model;
    source = `default-preset:${defaultPresetName}`;
  }

  const resolved: ResolvedSubagentModel = { source, decideThinking: false };
  if (model !== undefined) resolved.model = model;
  if (activePresetName && model !== undefined && model === activePreset?.model) {
    resolved.preset = activePresetName;
  }

  // Thinking: an explicit pin wins — the `model` parameter's `:level` suffix,
  // frontmatter `thinking`, or the frontmatter model's own suffix. Otherwise the
  // active preset's policy applies: a fixed level, or "decisions" (the default
  // when the preset does not say) which the classifier resolves at spawn time.
  // With no preset at all, only an inherited model leaves the level open.
  const pinned = param.thinking ?? frontmatterThinking ?? frontmatter.thinking;
  if (pinned) {
    resolved.thinking = pinned;
  } else if (activePreset) {
    const policy = activePreset.thinking ?? THINKING_DECISIONS;
    if (policy === THINKING_DECISIONS) resolved.decideThinking = true;
    else resolved.thinking = policy;
  } else if (model === undefined) {
    resolved.decideThinking = true;
  }
  // A tier name that reaches pi as a literal model id would kill the subagent
  // pane with "No models match pattern smart". Flag it so the caller can fail
  // with an actionable message instead.
  if (
    model !== undefined &&
    (source === "tool-param" || source === "frontmatter") &&
    (CANONICAL_MODEL_PRESETS as readonly string[]).includes(model)
  ) {
    const where = source === "tool-param" ? "the model tool parameter" : "its frontmatter";
    const who = input.agentName ? `Agent "${input.agentName}"` : "This agent";
    resolved.warning =
      `${who} selects model "${model}" via ${where}, but no "${model}" preset is configured in ` +
      `modelPresets (config.json). Define it, or use a literal model id.`;
  }

  return resolved;
}
