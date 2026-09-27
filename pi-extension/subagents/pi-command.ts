import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Command used to launch a Pi-backed subagent when nothing is configured.
 *
 * Launch scripts run in a NON-interactive bash (`#!/bin/bash` + explicit
 * `bash <script>`), so shell aliases and `.zshrc` definitions are never in
 * scope here: the configured value must be a real executable or a full
 * command line, not an alias.
 */
export const DEFAULT_PI_COMMAND = "pi";

/** Environment variable that overrides the configured pi command. */
export const PI_COMMAND_ENV_VAR = "PI_SUBAGENT_PI_BIN";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Directory (relative to the agent config dir) that holds standalone extensions. */
const EXTENSIONS_SUBDIR = join("extensions", "pi-interactive-subagents");

export interface PiCommandResolution {
  /**
   * Full command prefix (executable path or command line, possibly with
   * arguments) substituted for the hardcoded `pi` in the launch script.
   */
  command: string;
  /** `env:<VAR>`, a config file path, or `"default"` — for diagnostics. */
  source: string;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Config files consulted for `piBin`, in priority order: the extension's own
 * directory first, then a standalone `extensions/pi-interactive-subagents`
 * directory under the agent config dir.
 */
export function piCommandConfigPaths(agentDir: string): string[] {
  return [...new Set([join(PACKAGE_ROOT, "config.json"), join(agentDir, EXTENSIONS_SUBDIR, "config.json")])];
}

/**
 * Read the optional top-level `piBin` string from one config file.
 * Missing files yield `undefined`; malformed content throws so a typo is not
 * silently ignored.
 */
export function readPiCommandConfig(configPath: string): string | undefined {
  let rawConfig: string;
  try {
    rawConfig = readFileSync(configPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${configPath}: ${detail}`);
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid subagent config in ${configPath}: root must be an object`);
  }

  const value = (parsed as Record<string, unknown>).piBin;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid subagent config in ${configPath}: piBin must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Resolve the pi command for subagent launch scripts.
 *
 * Priority: `PI_SUBAGENT_PI_BIN` -> `piBin` in the first readable config file
 * (see piCommandConfigPaths) -> `DEFAULT_PI_COMMAND`.
 */
export function resolvePiCommand(options?: {
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  configPaths?: string[];
}): PiCommandResolution {
  const env = options?.env ?? process.env;

  const fromEnv = env[PI_COMMAND_ENV_VAR]?.trim();
  if (fromEnv) {
    return { command: fromEnv, source: `env:${PI_COMMAND_ENV_VAR}` };
  }

  const configPaths = options?.configPaths ?? piCommandConfigPaths(options?.agentDir ?? getAgentConfigDir(env));
  for (const configPath of configPaths) {
    const configured = readPiCommandConfig(configPath);
    if (configured) return { command: configured, source: configPath };
  }

  return { command: DEFAULT_PI_COMMAND, source: "default" };
}
