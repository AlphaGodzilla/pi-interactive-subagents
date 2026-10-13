import { getAgentConfigDir, extensionConfigPaths, readConfigFile } from "./config.ts";

/** Re-exported so existing importers keep working. */
export { getAgentConfigDir };

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

export interface PiCommandResolution {
  /**
   * Full command prefix (executable path or command line, possibly with
   * arguments) substituted for the hardcoded `pi` in the launch script.
   */
  command: string;
  /** `env:<VAR>`, a config file path, or `"default"` — for diagnostics. */
  source: string;
}

/**
 * Config files consulted for `piBin`, in ASCENDING priority order (the last one
 * that declares `piBin` wins, so project overrides global — same layering as
 * every other key).
 */
export function piCommandConfigPaths(agentDir: string): string[] {
  return extensionConfigPaths({ agentDir, cwd: process.cwd() });
}

/**
 * Read the optional top-level `piBin` string from one config file.
 * Missing files yield `undefined`; malformed content throws so a typo is not
 * silently ignored.
 */
export function readPiCommandConfig(configPath: string): string | undefined {
  const parsed = readConfigFile(configPath);
  if (!parsed) return undefined;

  const value = parsed.piBin;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid subagent config in ${configPath}: piBin must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Resolve the pi command for subagent launch scripts.
 *
 * Priority: `PI_SUBAGENT_PI_BIN` -> `piBin` from the highest-priority config
 * file that declares it (see piCommandConfigPaths) -> `DEFAULT_PI_COMMAND`.
 */
export function resolvePiCommand(options?: {
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  /** Ascending priority: the last entry that declares `piBin` wins. */
  configPaths?: string[];
}): PiCommandResolution {
  const env = options?.env ?? process.env;

  const fromEnv = env[PI_COMMAND_ENV_VAR]?.trim();
  if (fromEnv) {
    return { command: fromEnv, source: `env:${PI_COMMAND_ENV_VAR}` };
  }

  const configPaths = options?.configPaths ?? piCommandConfigPaths(options?.agentDir ?? getAgentConfigDir(env));
  for (const configPath of [...configPaths].reverse()) {
    const configured = readPiCommandConfig(configPath);
    if (configured) return { command: configured, source: configPath };
  }

  return { command: DEFAULT_PI_COMMAND, source: "default" };
}
