import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Directory (relative to a config root) that holds this extension's standalone config. */
const EXTENSION_CONFIG_DIR = join("extensions", "pi-interactive-subagents");

/**
 * Tolerated misspelling of the extensions directory. Users type
 * `.pi/extentions/...` often enough that silently ignoring the file would be
 * indistinguishable from "the feature does not work".
 */
const EXTENSION_CONFIG_DIR_LEGACY = join("extentions", "pi-interactive-subagents");

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export interface ConfigPathOptions {
  cwd?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
}

/**
 * Every config file this extension reads, in ASCENDING priority order — each
 * later file is deep-merged over the previous ones, so the project layer wins
 * over the global one and both win over the bundled defaults:
 *
 *   1. the extension's own `config.json` (bundled defaults)
 *   2. `$PI_CODING_AGENT_DIR/extentions/pi-interactive-subagents/config.json` (legacy spelling)
 *   3. `$PI_CODING_AGENT_DIR/extensions/pi-interactive-subagents/config.json` (global)
 *   4. `<cwd>/.pi/extentions/pi-interactive-subagents/config.json` (legacy spelling)
 *   5. `<cwd>/.pi/extensions/pi-interactive-subagents/config.json` (project)
 *
 * One list for every key (`status`, `piBin`, `modelPresets`, `classifierModel`,
 * ...) so a project config can override everything the global one sets.
 */
export function extensionConfigPaths(options: ConfigPathOptions = {}): string[] {
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
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
export function readConfigFile(configPath: string): Record<string, unknown> | null {
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

  if (!isPlainObject(parsed)) throw new Error(`Invalid subagent config ${configPath}: root must be an object`);
  return parsed;
}

export interface LoadedConfig {
  /** Deep-merged config across every existing layer. */
  merged: Record<string, unknown>;
  /** Files that contributed, in ascending priority order. */
  sources: string[];
}

export interface LoadConfigOptions extends ConfigPathOptions {
  /** Explicit layer list (ascending priority); overrides the default lookup. */
  configPaths?: string[];
}

/** Load and deep-merge every layer. Throws on malformed content. */
export function loadMergedConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const configPaths = options.configPaths ?? extensionConfigPaths(options);

  const sources: string[] = [];
  let merged: Record<string, unknown> = {};
  for (const configPath of configPaths) {
    const parsed = readConfigFile(configPath);
    if (!parsed) continue;
    merged = mergeConfigObjects(merged, parsed);
    sources.push(configPath);
  }

  return { merged, sources };
}

interface ConfigCacheEntry {
  signature: string;
  value: LoadedConfig;
}

let configCache: ConfigCacheEntry | null = null;

/**
 * `path:mtimeMs:size` per layer — a change makes the next read re-parse instead
 * of reusing the cache, so an edited `config.json` takes effect without a
 * reload while hot paths (widget refresh, status polls) stay syscall-cheap.
 */
function configSignature(configPaths: string[]): string {
  return configPaths
    .map((configPath) => {
      try {
        const stat = statSync(configPath);
        return `${configPath}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${configPath}:-`;
      }
    })
    .join("|");
}

/**
 * `loadMergedConfig` with a change-detecting cache. Every setting in the
 * extension reads through this, so all keys always see the same generation of
 * the same files.
 */
export function loadMergedConfigCached(options: LoadConfigOptions = {}): LoadedConfig {
  const configPaths = options.configPaths ?? extensionConfigPaths(options);
  const signature = configSignature(configPaths);
  if (configCache?.signature === signature) return configCache.value;

  const value = loadMergedConfig({ ...options, configPaths });
  configCache = { signature, value };
  return value;
}
