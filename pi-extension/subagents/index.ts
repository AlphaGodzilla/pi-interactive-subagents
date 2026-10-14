import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeSurface,
  listSubagentPanes,
  listAllSurfaces,
  resolveWorktreeContext,
  findWorktreeContextByPath,
  sendEnter,
  type HerdrWorktreeContext,
  getMuxBackend,
  sendEscape,
  shellEscape,
  readScreen,
  isLiveAgentStatus,
  listLiveAgentPaneSurfaces,
  findPaneInfo,
  type MuxPaneInfo,
} from "./cmux.ts";

import {
  findLastAssistantMessage,
  getNewEntries,
  getSessionCwd,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusWake,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  type StatusConfig,
} from "./status.ts";
import { DEFAULT_PI_COMMAND, getAgentConfigDir, resolvePiCommand } from "./pi-command.ts";
import {
  loadModelPresetConfig,
  resolveSubagentModel,
  type ModelPresetConfig,
} from "./model-presets.ts";
import {
  chooseSubagentModel,
  chooseThinkingLevel,
  type ClassifierDecision,
  type ClassifierObserver,
} from "./model-classifier.ts";
import { appendClassifierDecision, describeClassifierDecision } from "./classifier-log.ts";
import { resolveLaunchModelTarget, type ModelRegistryLike } from "./model-registry.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import { appendSteerMessage, getSubagentSteerFile } from "./steer.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  rotateModuleAbortController();
}

/**
 * Abort the current process-wide poll controller and install a fresh one.
 *
 * POLL_ABORT_KEY is a process-wide singleton (Symbol.for on globalThis, so it
 * survives /reload). Aborting it kills watchers that captured the previous
 * controller; installing a fresh one immediately after means future watchers
 * (getModuleAbortSignal) are never left pointing at an aborted signal.
 */
function rotateModuleAbortController(): void {
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort && !prevAbort.signal.aborted) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

/**
 * Return a live abort signal for watcher poll loops.
 *
 * Self-heals: if the stored controller was aborted by anything other than a
 * module reload (e.g. a session_shutdown that raced ahead of this spawn),
 * rotate so the returned signal is never already-aborted.
 */
function getModuleAbortSignal(): AbortSignal {
  const current = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (current?.signal.aborted) {
    rotateModuleAbortController();
  }
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model override (overrides agent default). A value that names a configured `modelPresets` entry (e.g. \"smart\") selects that preset; any other value is a literal model reference (provider/modelId, bare id, or a partial name like \"sonnet\") resolved against the model catalog before launch. An optional `:<thinking>` suffix sets the level, e.g. \"smart:high\" (what subagent_choose_model returns).",
    }),
  ),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  worktree: Type.Optional(
    Type.String({
      description:
        "Git worktree to run the sub-agent in (herdr only; the project must be a Git repository). Value is a worktree name, e.g. \"hotfix-issue-20\": an existing worktree with that name is reused, otherwise one is created as a sibling directory `<repo-dir>-<name>` on a new branch with that name. The pane/tab opens inside the worktree's herdr workspace and the sub-agent starts in the worktree directory (overrides cwd). When the repository has CodeGraph enabled (`.codegraph` in the main checkout and the `codegraph` CLI on PATH), the checkout's index is prepared first — `codegraph init` for a fresh checkout, `codegraph sync` when it already has an index; a preparation failure only adds a warning.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

/** How a subagent surface is opened in the multiplexer. */
type SubagentMuxMode = "pane" | "tab";

function parseMuxMode(value: string | undefined): SubagentMuxMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "pane" || normalized === "tab") return normalized;
  return undefined;
}

function resolveMuxMode(agentDefs: AgentDefaults | null): SubagentMuxMode {
  return agentDefs?.mux ?? "pane";
}

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  /** How to open the subagent surface: split a pane (default) or create a tab. */
  mux?: SubagentMuxMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_choose_model",
  "subagent_resume",
  "subagent_steer",
  "subagent_cleanup",
  "subagents_status",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    mux: parseMuxMode(getFrontmatterValue(frontmatter, "mux")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

interface ParentModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Resolve the most recent model_change event from the parent session file.
 *
 * A subagent launched via `pi --session <child>` only gets a model when the
 * extension or the agent frontmatter supplies one. Without it pi falls back to
 * its CLI default provider ("google"), which is unauthenticated on machines
 * that run custom proxy providers (cpa_mybitx, ...): the child pi then dies
 * instantly with exit code 1 before writing any session output — the
 * "subagent aborts 1s after launch" failure mode. Explicitly inheriting the
 * parent's provider + model makes every launch deterministic.
 */
function resolveParentModel(parentSessionFile: string): ParentModelSpec | null {
  try {
    const raw = readFileSync(parentSessionFile, "utf8");
    let provider: string | null = null;
    let modelId: string | null = null;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (
          entry?.type === "model_change" &&
          typeof entry.provider === "string" &&
          typeof entry.modelId === "string"
        ) {
          // Keep walking: the last model_change is the current model.
          provider = entry.provider;
          modelId = entry.modelId;
        }
      } catch {
        // ignore malformed lines
      }
    }
    return provider && modelId ? { provider, modelId } : null;
  } catch {
    return null;
  }
}

/**
 * Read the tail of a pane stripped of ANSI escapes, for failure diagnostics.
 * Returns "" when the surface is already gone or has no readable output.
 */
function readPaneTail(surface: string, lines = 40): string {
  try {
    const raw = readScreen(surface, lines);
    const clean = raw
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b[()][AB0]/g, "")
      .replace(/\x1b\[[0-9;]*m/g, "");
    return clean
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, or bare fork spawns) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call with
 * `fork: true`), `autoExit` is undefined and the subagent is treated as
 * interactive — matching the intent of a fork.
 */
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefinition | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Badge shown by `subagents_list`: the configured preset and the model it
 * resolves to (`smart → anthropic/claude-opus-4-1`), or the literal model.
 */
function formatModelBadge(model: string | undefined, config: ModelPresetConfig): string | undefined {
  const resolved = resolveSubagentModel({ config, frontmatterModel: model });
  if (!resolved.model) return undefined;
  if (resolved.source.startsWith("preset:") && resolved.preset) {
    return `${resolved.preset} → ${resolved.model}`;
  }
  if (resolved.source.startsWith("default-preset:") && resolved.preset) {
    return `${resolved.preset} (default) → ${resolved.model}`;
  }
  return resolved.model;
}

/**
 * Observability for classifier (decision model) requests: append the record to
 * the session's `classifier-decisions.jsonl` and tell the user what was decided.
 * Failures are logged but not notified — a missing classifier must not nag on
 * every spawn.
 */
function makeClassifierObserver(options: {
  artifactDir?: string;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
}): ClassifierObserver {
  return (decision: ClassifierDecision) => {
    if (options.artifactDir) appendClassifierDecision(options.artifactDir, decision);
    // One notification per completed decision: a two-call decision reports the
    // tier first (final: false) and the thinking level last.
    if (decision.final !== false && !decision.error && options.notify) {
      options.notify(describeClassifierDecision(decision), "info");
    }
  };
}

/**
 * Machine-readable facts for the classifier, next to the prose task text.
 *
 * The task alone describes *what* to do, not how hard it is: these are the
 * signals that make the tier/thinking questions answerable — a read-only tool
 * set, the working directory, the parent's model, and the size of the task text.
 */
function classifierContext(input: {
  task: string;
  /**
   * The prompt the subagent will actually receive (role block + wrapper +
   * task). Only the spawn path knows it; decision logs without `promptChars`
   * came from the tool, before the caller composed the spawn.
   */
  promptText?: string;
  agentDefs?: AgentDefinition | null;
  cwd?: string;
  parentModel?: ParentModelSpec | null;
}): Record<string, unknown> {
  const context: Record<string, unknown> = { taskChars: input.task.length };
  // The gap between these two is exactly the "the classifier saw 8% of the
  // prompt" problem: it is logged so it stays measurable.
  if (input.promptText) context.promptChars = input.promptText.length;

  // The role the subagent will be told to play — the agent body is injected as
  // its system prompt or role block, and the classifier otherwise only sees a
  // one-line description.
  const role = input.agentDefs?.body?.trim();
  if (role) context.agentRole = truncateToChars(role, CLASSIFIER_AGENT_ROLE_CHARS);

  const tools = input.agentDefs?.tools?.trim();
  if (tools) {
    context.agentTools = tools;
    // A tool set without a writer is a read-only agent — the strongest
    // difficulty signal we can compute locally.
    context.readOnly = !tools.split(",").some((tool) => {
      const name = tool.trim().toLowerCase();
      return name === "edit" || name === "write";
    });
  }
  if (input.agentDefs?.skills) context.agentSkills = input.agentDefs.skills;
  if (input.agentDefs?.systemPromptMode) context.systemPromptMode = input.agentDefs.systemPromptMode;
  if (input.agentDefs?.sessionMode) context.agentSessionMode = input.agentDefs.sessionMode;
  if (input.cwd) context.cwd = input.cwd;
  if (input.parentModel) {
    context.parentModel = `${input.parentModel.provider}/${input.parentModel.modelId}`;
  }
  return context;
}

/** Longest agent body handed to the classifier; the rest is dropped. */
const CLASSIFIER_AGENT_ROLE_CHARS = 4_000;

/** Truncate with an explicit marker, so the classifier can tell it was cut. */
function truncateToChars(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

/** ` (p=0.62)` for the picked label, when the classifier reported probabilities. */
function formatProbability(probabilities: Record<string, number> | undefined, label: string): string {
  const value = probabilities?.[label];
  return typeof value === "number" ? ` (p=${value.toFixed(2)})` : "";
}

/** First text block of a tool result, for renderers that only show the text. */
function resultText(result: { content: readonly unknown[] }): string {
  const part = result.content[0] as { text?: unknown } | undefined;
  return typeof part?.text === "string" ? part.text : "";
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/**
 * Status display settings, read lazily and cached by file mtime — never at
 * import time, so a broken config cannot stop the extension from loading, and an
 * edited one is picked up on the next widget tick without a reload.
 */
function statusSettings(): StatusConfig {
  return loadStatusConfig({ cwd: process.cwd() });
}

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

/**
 * Fallback summary for a subagent that produced no assistant text. A
 * surface-gone exit carries a synthetic non-zero code (the child was killed
 * from outside and never reported a status), so it must not be presented as a
 * real exit code.
 */
function formatSubagentExitFallback(
  reason: "done" | "ping" | "sentinel" | "error" | "surface-gone" | undefined,
  exitCode: number,
): string {
  if (reason === "surface-gone") {
    return "Sub-agent pane was closed externally before it finished (exit status unknown)";
  }
  return exitCode !== 0 ? `Sub-agent exited with code ${exitCode}` : "Sub-agent exited without output";
}

/**
 * Human-facing "resume this session" hint. Uses the configured pi command
 * (`piBin` / PI_SUBAGENT_PI_BIN) so a copied hint reproduces the environment
 * the subagent was launched with.
 */
function formatResumeHint(sessionFile: string): string {
  return `\n\nSession: ${sessionFile}\nResume: ${resolvePiCommand().command} --session ${sessionFile}`;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile ? formatResumeHint(result.sessionFile) : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  steerFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  /** How this subagent's surface was opened (pane split or tab). */
  muxMode?: SubagentMuxMode;
  /**
   * Set when this subagent runs inside a herdr git-worktree workspace. `reap`
   * means the workspace was opened by this spawn (safe to close once every
   * subagent placed there finished); already-open user workspaces are kept.
   */
  worktree?: { workspaceId: string; rootPane: string; reap: boolean };
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/**
 * Share the running registry with sibling extensions in the same pi process
 * (subagent-done.ts refuses to auto-exit while spawned subagents are still
 * running). Deliberately on globalThis: both extensions are separate modules
 * loaded into the same session.
 */
const RUNNING_REGISTRY_GLOBAL_KEY = "__piSubagentRunningRegistry";
(globalThis as any)[RUNNING_REGISTRY_GLOBAL_KEY] = runningSubagents;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusSettings().enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

function listRunningSubagentTargets(): string {
  const targets = Array.from(runningSubagents.values());
  if (targets.length === 0) return "";
  return targets.map((running) => `"${running.name}" [id ${running.id}]`).join(", ");
}

function matchRunningByName(name: string): { running: RunningSubagent } | { error: string } | null {
  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === name);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) return null;
  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${name}". Matches: ${candidates}` };
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    if (running) return { running };

    // Callers (the model, or users copying the name from the widget/spawn
    // result) often pass the display name in the `id` field when the internal
    // hex id is unknown. Fall back to a display-name match before giving up so
    // interrupt/steer work with name-as-id arguments too.
    const byDisplayName = matchRunningByName(requestedId);
    if (byDisplayName) return byDisplayName;

    const runningList = listRunningSubagentTargets();
    const hint = runningList ? ` Running subagents: ${runningList}.` : "";
    return { error: `No running subagent with id "${requestedId}".${hint}` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const byName = matchRunningByName(requestedName);
  if (byName) return byName;

  const runningList = listRunningSubagentTargets();
  const hint = runningList ? ` Running subagents: ${runningList}.` : "";
  return { error: `No running subagent named "${requestedName}".${hint}` };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.cli === "claude") {
    return {
      content: [{
        type: "text" as const,
        text:
          "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
      }],
      details: { error: "claude interrupt unsupported", id: running.id, name: running.name },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

/**
 * Enqueue a steering message for a running subagent. The message is written
 * to the child's steer inbox; the child's subagent-done extension drains it
 * and injects it into the child session as a user message (interrupting the
 * current turn after the in-flight tool execution when busy).
 */
function handleSubagentSteer(
  params: { id?: string; name?: string; message?: string },
  append: (steerFile: string, message: string, from?: string) => void = appendSteerMessage,
) {
  const message = params.message?.trim();
  if (!message) {
    return {
      content: [{ type: "text" as const, text: "Provide a steering message to send." }],
      details: { error: "message required" },
    };
  }

  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.cli === "claude") {
    return {
      content: [{
        type: "text" as const,
        text:
          "Steering is currently supported only for Pi-backed subagents. Claude-backed steering has not been verified yet.",
      }],
      details: { error: "claude steer unsupported", id: running.id, name: running.name },
    };
  }

  if (!running.steerFile) {
    return {
      content: [{
        type: "text" as const,
        text:
          `Subagent "${running.name}" has no steer inbox — it was launched before steering support or not by this orchestrator.`,
      }],
      details: { error: "no steer inbox", id: running.id, name: running.name },
    };
  }

  try {
    append(running.steerFile, message);
  } catch (error: any) {
    return {
      content: [{
        type: "text" as const,
        text: `Failed to queue steering message for subagent "${running.name}": ${error?.message ?? String(error)}`,
      }],
      details: { error: "steer write failed", id: running.id, name: running.name },
    };
  }

  return {
    content: [{
      type: "text" as const,
      text:
        `Steering message queued for subagent "${running.name}". ` +
        "It will be delivered into the subagent's session (interrupting the current turn after the in-flight tool execution when busy).",
    }],
    details: { id: running.id, name: running.name, message, status: "steered" },
  };
}

/**
 * Clean up dead/orphaned subagent entries: closes their panes and removes
 * them from the running registry. Use when a subagent never made it into pi
 * (empty pane left behind) or died without a watcher-detected exit, leaving a
 * permanent `stalled` entry in the widget.
 *
 * - With id/name: force-clean that one subagent regardless of its status
 *   (its pane is closed and its pending result is abandoned).
 * - Without: clean every entry currently classified as `stalled`.
 */
/**
 * Close a herdr git-worktree workspace once every subagent placed there has
 * finished. Only workspaces this session opened/created are reaped (`reap`);
 * a workspace the user already had open is left running. Closing the root pane
 * makes herdr recycle the workspace itself; the git worktree checkout stays on
 * disk and is reused by the next spawn.
 *
 * Two hard guards keep the reap from killing live agents:
 * - Never close the pane this process itself runs in. A nested orchestrator
 *   inherits the enclosing worktree metadata; reaping that workspace would
 *   close the very pane it lives in and kill it mid-turn.
 * - Never recycle a workspace that still hosts a live agent pane (e.g. a
 *   nested subagent that outlived the parent that opened the workspace).
 *   Closing the root pane recycles the whole workspace, so when liveness
 *   cannot be verified the workspace is left open instead. Skipping the reap
 *   does not leak workspaces in the normal case: once the last pane in it is
 *   closed (the watcher closes the finished subagent's own pane first), herdr
 *   recycles the workspace by itself.
 */
function maybeReapWorktreeWorkspace(
  worktree: RunningSubagent["worktree"],
  closeSurfaceFn: (surface: string) => void = closeSurface,
  livePaneSurfacesFn: () => string[] | null = listLiveAgentPaneSurfaces,
): void {
  if (!worktree || !worktree.reap || !worktree.rootPane) return;
  const self = currentSurfaceId();
  if (self !== null && worktree.rootPane === self) return;
  for (const running of runningSubagents.values()) {
    if (running.worktree?.workspaceId === worktree.workspaceId) return;
  }
  let livePaneSurfaces: string[] | null = null;
  try {
    livePaneSurfaces = livePaneSurfacesFn();
  } catch {
    livePaneSurfaces = null;
  }
  // Unverifiable liveness: refusing to reap only leaves a workspace open,
  // while reaping blindly can kill another session's running agent.
  if (livePaneSurfaces === null) return;
  if (livePaneSurfaces.some((surface) => surfaceWorkspaceId(surface) === worktree.workspaceId)) return;
  try {
    closeSurfaceFn(worktree.rootPane);
  } catch {
    // Best effort: the pane/workspace may already be gone.
  }
}

function handleSubagentCleanup(
  params: { id?: string; name?: string; surface?: string },
  closeSurfaceFn: (surface: string) => void = closeSurface,
  deps: { findPaneFn?: (surface: string) => MuxPaneInfo | null } = {},
) {
  const now = Date.now();
  const targets: RunningSubagent[] = [];

  const requestedId = params.id?.trim();
  const requestedName = params.name?.trim();
  const requestedSurface = params.surface?.trim();

  // Direct surface cleanup: removes an orphaned pane/tab that has no running
  // entry (e.g. a dead tab left behind after a session restart). Closing the
  // tab's root pane reaps the tab itself when it holds no other panes.
  if (requestedSurface) {
    const tracked = Array.from(runningSubagents.values()).find((r) => r.surface === requestedSurface);

    // Never close a pane that is running another pi session's live agent.
    // A labeled pane this session does not track may belong to a nested
    // orchestrator (its own subagent) or another window; herdr reports the
    // pane's agent state, and only a pane with no live agent may be closed.
    if (!tracked) {
      const findPaneFn = deps.findPaneFn ?? findPaneInfo;
      let pane: MuxPaneInfo | null = null;
      try {
        pane = findPaneFn(requestedSurface);
      } catch {
        pane = null;
      }
      if (pane && isLiveAgentStatus(pane.agentStatus)) {
        const owner = pane.agentSession ? ` (session: ${pane.agentSession})` : "";
        const kind = pane.agentKind ? `${pane.agentKind} ` : "";
        const message =
          `Refused to close surface ${requestedSurface}: a live ${kind}agent is running in that pane ` +
          `(status: ${pane.agentStatus}). It belongs to another pi session${owner}, not to this one, and ` +
          `closing the pane would kill it mid-work. Steer or interrupt it from the session that spawned it, ` +
          `or close the pane manually if you know the agent is gone.`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            error: message,
            surface: requestedSurface,
            refused: true,
            reason: "live-agent",
            agentStatus: pane.agentStatus,
            agentKind: pane.agentKind,
            agentSession: pane.agentSession,
          },
        };
      }
    }
    try {
      closeSurfaceFn(requestedSurface);
    } catch (error: any) {
      const message = `Failed to close surface "${requestedSurface}": ${error?.message ?? String(error)}`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { error: message, surface: requestedSurface },
      };
    }
    if (tracked) {
      try {
        tracked.abortController?.abort();
      } catch {}
      runningSubagents.delete(tracked.id);
      maybeReapWorktreeWorkspace(tracked.worktree, closeSurfaceFn);
      updateWidget();
    }
    const trackedNote = tracked ? ` (running entry "${tracked.name}" [${tracked.id}] removed)` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Closed surface ${requestedSurface}${trackedNote}. The pane is gone; an empty tab is reaped automatically.`,
        },
      ],
      details: {
        cleaned: [{ id: tracked?.id ?? null, name: tracked?.name ?? null, surface: requestedSurface }],
        count: 1,
        status: "cleaned",
      },
    };
  }
  if (requestedId || requestedName) {
    const resolved = resolveInterruptTarget({ id: requestedId || undefined, name: requestedName || undefined });
    if ("error" in resolved) {
      return {
        content: [{ type: "text" as const, text: resolved.error }],
        details: { error: resolved.error },
      };
    }
    targets.push(resolved.running);
  } else {
    for (const running of runningSubagents.values()) {
      if (classifyStatus(running.statusState, now).kind === "stalled") targets.push(running);
    }
  }

  if (targets.length === 0) {
    const scope = requestedId || requestedName
      ? `No running subagent matches "${requestedId || requestedName}".`
      : "No stalled subagents to clean up.";
    return {
      content: [{ type: "text" as const, text: scope }],
      details: { cleaned: [] },
    };
  }

  // A `stalled` classification (or an explicit id/name force-clean) is a
  // heuristic, not proof of death: never close a pane the multiplexer still
  // reports a live agent in — the child may be slow to start or busy in a long
  // tool call. Refused entries stay tracked and are reported back.
  const findPaneFn = deps.findPaneFn ?? findPaneInfo;
  const refused: Array<{ id: string; name: string; surface: string; agentStatus: string | null }> = [];
  const cleanable: RunningSubagent[] = [];
  for (const running of targets) {
    let pane: MuxPaneInfo | null = null;
    try {
      pane = findPaneFn(running.surface);
    } catch {
      pane = null;
    }
    if (pane && isLiveAgentStatus(pane.agentStatus)) {
      refused.push({ id: running.id, name: running.name, surface: running.surface, agentStatus: pane.agentStatus });
    } else {
      cleanable.push(running);
    }
  }

  if (cleanable.length === 0) {
    const names = refused.map((r) => `"${r.name}" [${r.id}] (${r.agentStatus ?? "live"})`).join(", ");
    const message =
      `Refused to clean up ${refused.length} subagent${refused.length > 1 ? "s" : ""}: ${names}. ` +
      "The pane still reports a live agent — a `stalled` entry can still be working (slow start, long tool call), " +
      "and closing its pane would kill it mid-work; its result (or failure) is delivered automatically. " +
      "Use subagent_interrupt to cancel its turn, or pass this surface explicitly if you know the agent is gone.";
    return {
      content: [{ type: "text" as const, text: message }],
      details: { cleaned: [], refused, refusedCount: refused.length, status: "refused" },
    };
  }

  const cleaned = cleanable.map((running) => {
    // Abort the watcher so its poll loop unwinds via the cancelled path
    // (it also closes the surface as best effort); the surface close below is
    // idempotent. The watcher's completion then reports "cancelled" to the
    // parent session, which is the expected acknowledgement of a cleanup.
    try {
      running.abortController?.abort();
    } catch {}
    try {
      closeSurfaceFn(running.surface);
    } catch {}
    runningSubagents.delete(running.id);
    return { id: running.id, name: running.name, surface: running.surface, worktree: running.worktree };
  });

  // Reap any worktree workspaces whose last subagent just finished.
  const reaped = new Set<string>();
  for (const c of cleaned) {
    const wt = c.worktree;
    if (wt?.reap && wt.rootPane && !reaped.has(wt.workspaceId)) {
      reaped.add(wt.workspaceId);
      maybeReapWorktreeWorkspace(wt, closeSurfaceFn);
    }
  }

  updateWidget();

  const label = cleaned.map((c) => `"${c.name}" [${c.id}]`).join(", ");
  const forced = requestedId || requestedName ? "forced " : "stalled ";
  const refusalNote =
    refused.length > 0
      ? ` Refused ${refused.length} pane${refused.length > 1 ? "s" : ""} that still report${refused.length > 1 ? "" : "s"} a live agent: ${refused
          .map((r) => `"${r.name}" [${r.id}] (${r.agentStatus ?? "live"})`)
          .join(", ")} — a stalled entry can still be working; use subagent_interrupt to cancel its turn.`
      : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Cleaned up ${cleaned.length} ${forced}subagent${cleaned.length > 1 ? "s" : ""}: ${label}. ` +
          "Panes closed and running entries removed." +
          refusalNote,
      },
    ],
    details:
      refused.length > 0
        ? { cleaned, count: cleaned.length, status: "cleaned", refused, refusedCount: refused.length }
        : { cleaned, count: cleaned.length, status: "cleaned" },
  };
}

interface OrphanProcess {
  pid: string;
  id: string;
  name: string;
  surface: string | null;
}

/**
 * Discover subagent pi processes that are alive but whose running entry is no
 * longer tracked (e.g. the orchestrator session restarted, or the watcher
 * never picked them up). Backend-agnostic: every pi subagent is launched with
 * PI_SUBAGENT_ID / PI_SUBAGENT_NAME / PI_SUBAGENT_SURFACE in its environment,
 * visible via `ps eww`.
 */
function discoverOrphanSubagentProcesses(
  trackedIds: ReadonlySet<string>,
  sessionDir: string | null,
): OrphanProcess[] {
  try {
    const out = execSync("ps eww -axo pid=,command=", {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      // Capture stderr: inherited stderr would leak into the agent TUI.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const byId = new Map<string, OrphanProcess>();
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const idMatch = m[2].match(/PI_SUBAGENT_ID=([0-9a-fA-F]{6,16})/);
      if (!idMatch) continue;
      const id = idMatch[1].toLowerCase();
      if (trackedIds.has(id)) continue;
      // Only report subagents launched under THIS orchestrator's session
      // directory — subagents of other pi sessions (other projects or other
      // windows over the same project) live in different session dirs.
      const sessionMatch = m[2].match(/PI_SUBAGENT_SESSION=(\S+)/);
      if (sessionDir) {
        if (!sessionMatch) continue;
        let childDir: string | null = null;
        try {
          childDir = dirname(sessionMatch[1]);
        } catch {}
        if (childDir !== sessionDir) continue;
      }
      // Names are launch slugs and rarely contain spaces; surface is optional
      // (env output can be truncated on some platforms).
      const nameMatch = m[2].match(/PI_SUBAGENT_NAME=(\S+)/);
      const surfaceMatch = m[2].match(/PI_SUBAGENT_SURFACE=(\S+)/);
      byId.set(id, {
        pid: m[1],
        id,
        name: nameMatch?.[1] ?? `subagent-${id}`,
        surface: surfaceMatch?.[1] ?? null,
      });
    }
    return Array.from(byId.values());
  } catch {
    return [];
  }
}

function currentSessionDir(): string | null {
  try {
    const file = latestCtx?.sessionManager?.getSessionFile();
    return file ? dirname(file) : null;
  } catch {
    return null;
  }
}

/** Session file of the session this process is running, when known. */
function currentSessionFileOrNull(): string | null {
  try {
    const file = latestCtx?.sessionManager?.getSessionFile();
    return typeof file === "string" && file !== "" ? file : null;
  } catch {
    return null;
  }
}

/** Pane id this process itself runs in, when the mux reports one. */
function currentSurfaceId(): string | null {
  const surface = process.env.PI_SUBAGENT_SURFACE ?? process.env.HERDR_PANE_ID ?? "";
  return surface !== "" ? surface : null;
}

/** Workspace part of a mux surface id ("w1R:p2" → "w1R"); null when unqualified. */
function surfaceWorkspaceId(surface: string): string | null {
  const index = surface.indexOf(":");
  return index > 0 ? surface.slice(0, index) : null;
}

/**
 * List every subagent that still has a pane open or a process alive,
 * independent of state: live registry entries, orphaned pi processes, and
 * orphaned named panes (where the backend supports pane naming). Lets the
 * caller see the full picture before deciding to interrupt, steer, clean up,
 * or close a pane manually.
 */
function handleSubagentsStatus(
  deps: {
    listAllSurfacesFn?: () => string[];
    listNamedPanesFn?: () => Array<{
      surface: string;
      label: string | null;
      agentStatus?: string | null;
      agentKind?: string | null;
      agentSession?: string | null;
    }>;
    currentSessionFileFn?: () => string | null;
    discoverOrphansFn?: (trackedIds: ReadonlySet<string>, sessionDir: string | null) => OrphanProcess[];
  } = {},
) {
  const listAll = deps.listAllSurfacesFn ?? listAllSurfaces;
  const listNamed = deps.listNamedPanesFn ?? listSubagentPanes;
  // Deps follow the *Fn convention: call the injected getter, else the default.
  const currentSessionFile = (deps.currentSessionFileFn ?? currentSessionFileOrNull)();
  const discover = deps.discoverOrphansFn ?? discoverOrphanSubagentProcesses;
  const now = Date.now();
  const trackedIds = new Set(runningSubagents.keys());
  const allSurfaces = listAll();
  const surfaceSet = new Set(allSurfaces);
  const namedPanes = listNamed();
  const orphanProcesses = discover(trackedIds, currentSessionDir());

  const entries: Array<Record<string, unknown>> = [];
  for (const running of runningSubagents.values()) {
    const snapshot = classifyStatus(running.statusState, now);
    entries.push({
      id: running.id,
      name: running.name,
      surface: running.surface,
      origin: "registry" as const,
      mux: running.muxMode ?? "pane",
      paneOpen: surfaceSet.has(running.surface),
      agent: running.agent ?? null,
      task: running.task,
      cli: running.cli ?? "pi",
      interactive: running.interactive,
      kind: snapshot.kind,
      statusLabel: snapshot.statusLabel,
      activityLabel: snapshot.activityLabel,
      elapsedMs: snapshot.elapsedMs,
    });
  }

  for (const orphan of orphanProcesses) {
    entries.push({
      id: orphan.id,
      name: orphan.name,
      surface: orphan.surface,
      origin: "orphan-process" as const,
      paneOpen: orphan.surface ? surfaceSet.has(orphan.surface) : false,
      pid: orphan.pid,
      agent: null,
      task: null,
      cli: "pi",
      interactive: false,
      kind: "orphan",
      statusLabel: null,
      activityLabel: null,
      elapsedMs: null,
    });
  }

  for (const pane of namedPanes) {
    const tracked = Array.from(runningSubagents.values()).some((r) => r.surface === pane.surface);
    if (tracked) continue;
    // A labeled pane this session does not track is NOT necessarily dead: it
    // may be running another pi session's live agent (a nested orchestrator's
    // subagent, another window). herdr reports the pane's agent state, so the
    // entry distinguishes `foreign` (alive — never clean up from here) from
    // `orphan` (no live agent detected).
    const agentStatus = pane.agentStatus ?? null;
    const agentSession = pane.agentSession ?? null;
    const live = isLiveAgentStatus(agentStatus);
    entries.push({
      id: null,
      name: pane.label ?? pane.surface,
      surface: pane.surface,
      origin: live ? ("live-pane" as const) : ("orphan-pane" as const),
      paneOpen: true,
      agent: null,
      task: null,
      cli: live ? (pane.agentKind ?? "unknown") : "unknown",
      interactive: false,
      kind: live ? "foreign" : "orphan",
      agentKind: pane.agentKind ?? null,
      agentStatus,
      agentSession,
      ownedByThisSession:
        agentSession !== null && currentSessionFile !== null ? agentSession === currentSessionFile : null,
      statusLabel: null,
      activityLabel: live ? agentStatus : null,
      elapsedMs: null,
    });
  }

  if (entries.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No subagents or subagent panes found." }],
      details: { count: 0, entries: [] },
    };
  }

  const lines = entries.map((e: any) => {
    if (e.origin === "orphan-process") {
      const pane = e.surface ? `, pane ${e.surface}` : "";
      return `• ${e.name} [orphan ${e.id}] — pi process alive (pid ${e.pid})${pane}, no running entry (restart the session to track it, or kill the process)`;
    }
    if (e.origin === "live-pane") {
      const status = e.agentStatus ? ` (${e.agentStatus})` : "";
      const agentName = e.agentKind ? `${e.agentKind} ` : "";
      const owner = e.ownedByThisSession === true
        ? "this session"
        : e.agentSession
          ? `another pi session: ${e.agentSession}`
          : "another pi session";
      return `• ${e.name} [live pane ${e.surface}] — live ${agentName}agent${status} owned by ${owner}; not tracked here (steer/interrupt it from the session that spawned it)`;
    }
    if (e.origin === "orphan-pane") {
      return `• ${e.name} [orphan pane ${e.surface}] — no live pi agent detected; the pane may still run another process, so closing it is destructive (subagent_cleanup({surface: "${e.surface}"}) only when you are sure)`;
    }
    const detail = [e.kind, e.activityLabel ?? e.statusLabel].filter(Boolean).join(" · ");
    const elapsed = Math.floor((e.elapsedMs ?? 0) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    const agentTag = e.agent ? ` (${e.agent})` : "";
    const paneTag = e.paneOpen ? "" : " [pane closed]";
    const muxTag = e.mux === "tab" ? " [tab]" : "";
    const task = e.task ? e.task.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    const taskLine = task ? `\n    task: ${task}${task.length === 120 ? "…" : ""}` : "";
    return `• ${e.name} [${e.id}]${agentTag}${muxTag}${paneTag} — ${detail}, ${mm}:${ss}${taskLine}`;
  });

  const orphanCount = entries.filter((e: any) => (e.origin as string).startsWith("orphan")).length;
  const foreignCount = entries.filter((e: any) => e.kind === "foreign").length;
  const countSummary = [
    `${entries.filter((e: any) => e.origin === "registry").length} tracked`,
    `${orphanCount} orphan`,
    ...(foreignCount > 0 ? [`${foreignCount} live elsewhere`] : []),
  ].join(", ");

  return {
    content: [
      {
        type: "text" as const,
        text: `${entries.length} subagent${entries.length > 1 ? "s" : ""} (${countSummary}):\n${lines.join("\n")}`,
      },
    ],
    details: { count: entries.length, entries },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusSettings().enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    let stalledTransition = false;
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        if (transition === "stalled") stalledTransition = true;
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusSettings().lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusWake(transitionLines, statusSettings().lineLimit, stalledTransition),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow, stalled: stalledTransition },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  parseMuxMode,
  resolveMuxMode,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  resolveDenyTools,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  handleSubagentSteer,
  handleSubagentCleanup,
  handleSubagentsStatus,
  maybeReapWorktreeWorkspace,
  surfaceWorkspaceId,
  currentSurfaceId,
  formatSubagentExitFallback,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  resolveParentModel,
  rotateModuleAbortController,
  getModuleAbortSignal,
  runningSubagents,
  formatElapsed,
  formatModelBadge,
  classifierContext,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: { getSessionFile(): string | undefined; getSessionId(): string; getSessionDir(): string };
    cwd: string;
    /** Used to resolve literal `model` strings into a concrete provider/model pair. */
    modelRegistry?: ModelRegistryLike;
    /** Optional UI, used to surface classifier decisions as they happen. */
    ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  },
  options?: { surface?: string; worktree?: HerdrWorktreeContext },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;

  // Model + thinking level for this spawn. `modelPresets` from config.json
  // applies when neither the tool parameter nor the agent frontmatter pins a
  // model; the project layer (<cwd>/.pi/extensions/pi-interactive-subagents/
  // config.json) is deep-merged over the global one.
  //
  // Claude Code agents keep their own default model: the `defaultPreset` tier
  // is a pi-model target and must not retarget a `claude` CLI spawn. An
  // explicit frontmatter preset reference still applies.
  const modelPresets = loadModelPresetConfig({ cwd: ctx.cwd ?? process.cwd() });
  const effectivePresets =
    agentDefs?.cli === "claude" ? { ...modelPresets, defaultPreset: null } : modelPresets;
  const resolvedModel = resolveSubagentModel({
    config: effectivePresets,
    agentName: params.agent,
    paramModel: params.model,
    frontmatterModel: agentDefs?.model,
    frontmatterThinking: agentDefs?.thinking,
  });
  if (resolvedModel.warning) throw new Error(resolvedModel.warning);
  const effectiveModel = resolvedModel.model;
  const effectiveThinking = resolvedModel.thinking;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const resolvedPaths = resolveSubagentPaths(params, agentDefs);
  // A worktree placement pins the sub-agent to the worktree checkout.
  const effectiveCwd = options?.worktree?.path ?? resolvedPaths.effectiveCwd;
  const { localAgentDir, effectiveAgentDir } = resolvedPaths;
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  // A direct `worktree` param places this spawn. Nested subagents inherit the
  // enclosing worktree workspace through the env injected below so their panes
  // stay attributable to it, but they do NOT inherit reap rights: only the
  // process that opened the workspace may recycle it (an intermediate
  // orchestrator that reaped an inherited workspace would close the very pane
  // it is running in).
  const inheritedWorktreeWorkspace = process.env.PI_SUBAGENT_WORKTREE_WORKSPACE;
  const effectiveWorktree: { workspaceId: string; rootPane: string; reap: boolean } | undefined =
    options?.worktree
      ? {
          workspaceId: options.worktree.workspaceId,
          rootPane: options.worktree.rootPane,
          reap: options.worktree.openedByUs,
        }
      : inheritedWorktreeWorkspace
        ? {
            workspaceId: inheritedWorktreeWorkspace,
            rootPane: process.env.PI_SUBAGENT_WORKTREE_ROOT_PANE ?? "",
            // Nested spawns never reap: the workspace opener owns reaping.
            reap: false,
          }
        : undefined;

  const surface = options?.surface ?? createSurface(params.name, {
    mode: resolveMuxMode(agentDefs),
    worktree: options?.worktree
      ? {
          workspaceId: options.worktree.workspaceId,
          rootPane: options.worktree.rootPane,
          rootTabId: options.worktree.rootTabId,
          fresh: options.worktree.openedByUs,
        }
      : undefined,
  });
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = params.systemPrompt ?? agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    if (params.resumeSessionId) {
      cmdParts.push("--resume", shellEscape(params.resumeSessionId));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptName = `${(params.name || "subagent")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      muxMode: resolveMuxMode(agentDefs),
      ...(effectiveWorktree ? { worktree: effectiveWorktree } : {}),
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = [resolvePiCommand().command];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  // A model named literally (tool parameter or frontmatter) is resolved against
  // the model catalog first, so the child receives an explicit provider/model
  // pair instead of dying on "No models match pattern". Preset models pass
  // through as configured.
  const launchModel = resolveLaunchModelTarget(resolvedModel, ctx.modelRegistry);
  if (!launchModel.ok) throw new Error(launchModel.error);

  // The model the child actually runs on: the preset/literal target, or the
  // parent session's model when nothing pinned one. The thinking decision (and
  // the levels it may offer) is resolved against this model.
  let childModel: { provider?: string; id: string } | undefined = launchModel.target;

  if (launchModel.target) {
    if (launchModel.target.provider) {
      parts.push("--provider", shellEscape(launchModel.target.provider));
    }
    parts.push("--model", shellEscape(launchModel.target.id));
  } else {
    // No explicit model (no tool param / frontmatter model / modelPresets):
    // inherit the parent session's current model. Without this, pi falls back
    // to its CLI default provider ("google") — unauthenticated on proxy-only
    // setups — and the child dies instantly with exit code 1 before writing any
    // session output. Explicitly inheriting the parent's provider + model makes
    // every launch deterministic.
    const parentModel = resolveParentModel(sessionFile);
    if (parentModel) {
      parts.push("--provider", shellEscape(parentModel.provider));
      parts.push("--model", shellEscape(parentModel.modelId));
      childModel = { provider: parentModel.provider, id: parentModel.modelId };
    } else {
      throw new Error(
        `No model resolvable for subagent "${params.name}" ` +
        "(no --model / agent frontmatter model / modelPresets default / parent model_change). " +
        "Set a model on the agent frontmatter (agents/<agent>.md), pass the model tool parameter, " +
        "configure modelPresets (config.json), or run the parent session with a model.",
      );
    }
  }

  // Thinking level travels as its own flag: pi warns and ignores an unknown
  // level, while an unknown ":level" suffix would make --model unresolvable.
  if (effectiveThinking) {
    parts.push("--thinking", shellEscape(effectiveThinking));
  } else if (resolvedModel.decideThinking && childModel) {
    // Nothing pinned a level (the active preset says "decisions", or the model
    // is inherited): let the classifier pick one from the task, restricted to
    // what the child's model supports. A missing/unavailable classifier, or a
    // model without extended reasoning, simply leaves the flag off — spawning
    // never depends on it.
    const picked = await chooseThinkingLevel({
      registry: ctx.modelRegistry,
      config: modelPresets,
      agentName: params.agent,
      agentDescription: agentDefs?.description,
      // The prompt the child actually receives (role block + wrapper + task),
      // not the bare task argument — same text, same decision basis.
      task: fullTask,
      model: childModel,
      context: classifierContext({
        task: params.task,
        promptText: fullTask,
        agentDefs,
        cwd: targetCwdForSession,
        parentModel: resolveParentModel(sessionFile),
      }),
      observer: makeClassifierObserver({
        artifactDir,
        ...(ctx.ui ? { notify: (message, type) => ctx.ui!.notify(message, type) } : {}),
      }),
    });
    if (picked.ok && picked.thinking) {
      parts.push("--thinking", shellEscape(picked.thinking));
    }
  }

  // Pass agent body as system prompt via file to avoid shell escaping issues
  // with multiline content. Pi's --append-system-prompt and --system-prompt
  // auto-detect file paths and read their contents.
  if (identityInSystemPrompt && identity) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    parts.push(flag, shellEscape(syspromptPath));
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) {
    parts.push("--tools", shellEscape(toolAllowlist));
  }

  // Build env prefix: denied tools + subagent identity + config dir propagation
  const envParts: string[] = [];

  // If the target cwd has its own .pi/agent/, use that as the config root.
  // Otherwise propagate the current/global agent dir.
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  }

  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  const steerFile = getSubagentSteerFile(artifactDir, id);
  mkdirSync(dirname(steerFile), { recursive: true });
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_STEER_FILE=${shellEscape(steerFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  if (effectiveWorktree) {
    envParts.push(`PI_SUBAGENT_WORKTREE_WORKSPACE=${shellEscape(effectiveWorktree.workspaceId)}`);
    envParts.push(`PI_SUBAGENT_WORKTREE_ROOT_PANE=${shellEscape(effectiveWorktree.rootPane)}`);
    envParts.push(`PI_SUBAGENT_WORKTREE_REAP=${effectiveWorktree.reap ? "1" : "0"}`);
  }
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    steerFile,
    muxMode: resolveMuxMode(agentDefs),
    ...(effectiveWorktree ? { worktree: effectiveWorktree } : {}),
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      onTick() {
        observeRunningSubagent(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      try {
        closeSurface(surface);
      } catch {
        // The pane may already be gone (user closed it, workspace reaped).
      }
      runningSubagents.delete(running.id);
      maybeReapWorktreeWorkspace(running.worktree);

      return { name, task, summary, exitCode: result.exitCode, elapsed, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    // Pi subagent result extraction
    let summary: string;
    const exitFallback = formatSubagentExitFallback(result.reason, result.exitCode);
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary = findLastAssistantMessage(allEntries) ?? (result.errorMessage ? `Subagent error: ${result.errorMessage}` : exitFallback);
    } else {
      summary = result.errorMessage ? `Subagent error: ${result.errorMessage}` : exitFallback;
    }

    // Failed launches often die before writing anything to the session file
    // (e.g. pi CLI model-resolution or provider-auth errors on startup).
    // Surface the pane's last output so the orchestrator sees the real cause
    // instead of a bare exit code or "Aborted while waiting" noise.
    if (result.exitCode !== 0 || result.errorMessage) {
      try {
        const paneTail = readPaneTail(surface);
        if (paneTail) {
          summary = `${summary}\n\n--- last subagent pane output ---\n${paneTail}`;
        }
      } catch {
        // Pane already gone — nothing to capture.
      }
    }

    // The pane was closed externally (a user, another pi session's cleanup, or
    // a recycled workspace); the child never signalled completion and no real
    // exit status exists.
    const surfaceGone = result.reason === "surface-gone";
    if (surfaceGone && result.exitCode !== 0 && !result.errorMessage) {
      summary = `${summary}\n\n(Pane was closed externally before the sub-agent finished — a user or another pi session/agent may have closed it; no child exit status was observed.)`;
    }

    try {
      closeSurface(surface);
    } catch {
      // Already gone — fine.
    }
    runningSubagents.delete(running.id);
    maybeReapWorktreeWorkspace(running.worktree);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    // Grab the pane tail BEFORE tearing the surface down: when a child dies at
    // startup (model resolution, provider auth, ...) the pane is the only
    // place that records why. Without it the orchestrator only sees the
    // generic "Aborted while waiting for subagent to finish" message.
    let paneTail = "";
    try {
      paneTail = readPaneTail(surface);
    } catch {}
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);
    maybeReapWorktreeWorkspace(running.worktree);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: paneTail ? `Subagent cancelled.\n\n--- last subagent pane output ---\n${paneTail}` : "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    const errMessage = err?.message ?? String(err);
    return {
      name,
      task,
      summary: paneTail ? `Subagent error: ${errMessage}\n\n--- last subagent pane output ---\n${paneTail}` : `Subagent error: ${errMessage}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: errMessage,
      sessionFile,
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    // Abort the current watcher generation AND install a fresh controller.
    // pi fires session_shutdown on session replace/resume/quit — not just
    // /reload. Aborting without rotating permanently poisoned the shared
    // controller for the whole process: every subagent spawned afterwards
    // (in any session of this process) died instantly in pollForExit with
    // "Aborted while waiting for subagent to finish". Rotation kills only
    // watchers that captured the previous generation and keeps new spawns
    // working in the session that replaces this one.
    rotateModuleAbortController();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // Model-choice guidance points at subagent_choose_model only when that tool is
  // actually registered in this session — `spawning: false` and a
  // `deny-tools: subagent_choose_model` both remove it.
  const chooseModelGuidance = shouldRegister("subagent_choose_model")
    ? {
        description:
          " When you are unsure which model tier or thinking level a spawn should use, call subagent_choose_model first and pass its returned `modelParam` (e.g. `\"smart:high\"`) as this tool's `model` parameter — do not guess a modelPresets tier yourself.",
        snippet:
          " When the model tier/thinking level is not obvious, call subagent_choose_model first and pass its returned `modelParam` (e.g. \"smart:high\") as `model`.",
        guidelines: [
          "Before spawning, call subagent_choose_model when the right model tier or thinking level is not obvious, then pass its returned `modelParam` — e.g. \"smart:high\" — as the `model` parameter of the `subagent` tool. It accounts for the task's difficulty and clamps the thinking level to what the chosen preset's model supports.",
          "Do not invent modelPresets tiers or thinking levels yourself, and do not call subagent_choose_model in a loop: one call per spawn that needs a decision (it costs a classifier call).",
        ],
      }
    : { description: "", snippet: "", guidelines: [] as string[] };

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget ASYNC tool: every subagent runs in the background, the call returns immediately with only an acknowledgement, and watching a run cannot make it finish sooner. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT poll or babysit a run — no repeated subagents_status calls, no sleep/wait loops, no tail/watch scripts, no re-reading session or log files, and do not call subagents_list to check on one (it only lists agent templates). All of that is wasted work; the harness handles delivery for you. The ONLY reason to query subagents_status is an explicit user request for the current status of a subagent — then answer from that single snapshot. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. " +
        "The launch acknowledgement shows the subagent's internal id, e.g. `Sub-agent \"Worker\" [id a1b2c3d4] launched` — " +
        "keep that id in mind if you may need to interrupt (subagent_interrupt) or steer (subagent_steer) it later." +
        chooseModelGuidance.description,
      promptSnippet:
        "Spawn a background sub-agent in a mux pane (async, fire-and-forget: results arrive automatically — never poll the run; query subagents_status only if the user asks). " +
        "Keep the returned id — `Sub-agent \"Name\" [id a1b2c3d4] launched` — to interrupt (subagent_interrupt) or steer (subagent_steer) it later." +
        chooseModelGuidance.snippet,
      promptGuidelines: chooseModelGuidance.guidelines,
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Resolve an optional git worktree placement (herdr only, Git repo required).
        let worktree: HerdrWorktreeContext | undefined;
        const requestedWorktree = params.worktree?.trim();
        if (requestedWorktree) {
          // Locate the repo from the spawn's cwd when given (absolute or
          // relative to the session cwd), otherwise from the session cwd.
          const worktreeBaseDir = params.cwd
            ? params.cwd.startsWith("/")
              ? params.cwd
              : join(process.cwd(), params.cwd)
            : ctx.cwd;
          const resolved = await resolveWorktreeContext(requestedWorktree, worktreeBaseDir, {
            onCodegraphPrepare: (action, worktreePath) =>
              ctx.ui.notify(`Preparing CodeGraph index (codegraph ${action}) in ${worktreePath}…`, "info"),
          });
          if (!resolved.ok) {
            return {
              content: [{ type: "text", text: resolved.error }],
              details: { error: "worktree unavailable", worktree: requestedWorktree },
            };
          }
          worktree = resolved.context;
        }

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, ctx, { worktree });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately

            if (result.ping) {
              // Subagent is requesting help — steer a ping message with session path for resume
              const sessionRef = result.sessionFile ? formatResumeHint(result.sessionFile) : "";
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    agent: running.agent,
                    sessionFile: result.sessionFile,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const presentation = resolveResultPresentation(result, running.name);

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  piCommand: resolvePiCommand().command,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        const codegraphWarning = worktree?.codegraph?.warning;
        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" [id ${running.id}] launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.` +
                (codegraphWarning ? `\n\nWarning: ${codegraphWarning}` : ""),
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            ...(worktree?.codegraph && worktree.codegraph.action !== "skip"
              ? { codegraph: worktree.codegraph }
              : {}),
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent, cancelling its in-flight model turn " +
        "(including the current tool execution). Turn-level only: the child pane, session, watcher and running entry " +
        "remain alive; after the interrupt the child sits in `waiting` and still reports its result/failure if it later exits.\n" +
        "\nHOW TO TARGET THE SUBAGENT:\n" +
        "- id (preferred): the 8-hex id from the spawn result, e.g. `Sub-agent \"x\" [id a1b2c3d4] launched`. Unique and unambiguous.\n" +
        "- name (fallback): the exact display name used at spawn, when the id is unknown. Names are not guaranteed " +
        "  unique; an ambiguous name is rejected with the list of candidates.\n" +
        "- Never put a display name into the id parameter — id accepts only the 8-hex internal id.\n" +
        "\nWHEN TO INTERRUPT:\n" +
        "- The user asked to stop or pause it, or it is demonstrably stuck (its pane shows an error or repeated " +
        "  failures). A `stalled` status line is NOT a reason: it only means no activity update for ~1 minute, and " +
        "  the subagent may still be working.\n" +
        "- The interrupt cancels the turn in flight — in-progress work can be lost; prefer subagent_steer to redirect " +
        "  it when cancelling is not necessary.",
      promptSnippet:
        "Interrupt the active turn of a running subagent — only when the user asked to stop/pause it or you verified it is stuck (a `stalled` status line alone is not a reason). Target it by the [id ...] from its spawn result (preferred) or by its display name in name — never pass the display name as id.",
      promptGuidelines: [
        "Use subagent_interrupt to cancel a running subagent's current turn: pass the 8-hex id from its spawn result (the `[id a1b2c3d4]` in `Sub-agent ... launched`) in the id parameter; if you only remember the display name, pass it in the name parameter — never in id.",
        "Interrupt a subagent only when the user asked to stop/pause/cancel it or you verified it is stuck — a `stalled` status is NOT a reason (it only means no activity update for ~1 min and the subagent may still be working). Interrupting cancels its in-flight turn and can lose work; prefer subagent_steer to redirect.",
      ],
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Internal id (8-hex, shown in the spawn result as [id ...]). If unknown, put the display name in the name field instead." })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name; the name field is the reliable way to target a subagent when its internal id is unknown." })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_steer tool ──
  if (shouldRegister("subagent_steer"))
    pi.registerTool({
      name: "subagent_steer",
      label: "Steer Subagent",
      description:
        "Queue a steering message for a currently running Pi-backed subagent. The child drains its inbox and injects " +
        "the message as a user message: if the subagent is mid-turn it interrupts after the current tool execution, " +
        "if it is idle it starts a new turn. Delivery is asynchronous (the child polls its inbox ~every 500ms); " +
        "queuing returns immediately and does not emit a subagent_result by itself.\n" +
        "To simply cancel the current turn WITHOUT adding a message, use subagent_interrupt instead.\n" +
        "\nHOW TO TARGET THE SUBAGENT (same rules as subagent_interrupt):\n" +
        "- id (preferred): the 8-hex id from the spawn result, e.g. `Sub-agent \"x\" [id a1b2c3d4] launched`.\n" +
        "- name (fallback): the exact display name used at spawn, when the id is unknown (not guaranteed unique).\n" +
        "- Never put a display name into the id parameter — id accepts only the 8-hex internal id.",
      promptSnippet:
        "Queue a steering message for a running subagent (delivered as a user message, async). Target it by the [id ...] from its spawn result (preferred) or its display name in name — never name-as-id. Use subagent_interrupt to cancel a turn without messaging.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Internal id (8-hex, shown in the spawn result as [id ...]). If unknown, put the display name in the name field instead." })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name; the name field is the reliable way to target a subagent when its internal id is unknown." })),
        message: Type.String({ description: "The steering message to deliver to the subagent" }),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentSteer(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — steer"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "steered") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — steering message queued"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_cleanup tool ──
  if (shouldRegister("subagent_cleanup"))
    pi.registerTool({
      name: "subagent_cleanup",
      label: "Clean Up Subagents",
      description:
        "Clean up dead/orphaned subagent entries: closes their panes and removes them from the running registry. " +
        "Use when a subagent never made it into pi (only an empty pane was left behind) or died in a way the watcher " +
        "did not detect, leaving a `stalled` entry in the widget.\n" +
        "`stalled` is a heuristic — a slow start or a long tool call looks the same — so cleanup is for leftovers, " +
        "never a reaction to a status line.\n" +
        "\nTARGETING:\n" +
        "- No id/name: every entry currently classified as `stalled` (active/waiting entries and live-agent panes are " +
        "  untouched).\n" +
        "- id or name: force that one entry regardless of status — its pane is closed and any pending result is " +
        "  abandoned; refused when its pane reports a live agent. Same targeting as subagent_interrupt.\n" +
        "- surface: close that mux surface directly (orphaned panes/tabs with no running entry; a tab reaps when its " +
        "  root pane closes). An untracked surface is refused when its pane reports a LIVE agent (`foreign`, e.g. a " +
        "  nested orchestrator's subagent); a tracked entry closes regardless, so use this deliberately.\n" +
        "The cleaned subagent's watcher reports `cancelled` to you as the acknowledgement.",
      promptSnippet:
        "Clean up dead/leftover subagents: no args = `stalled` entries, id/name = force one, surface = close a pane directly. For leftovers only — never a reaction to a `stalled` status line; to cancel a running subagent's turn use subagent_interrupt instead.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Internal id (8-hex) of the subagent to force-clean; omit to clean all stalled entries" })),
        name: Type.Optional(Type.String({ description: "Display name of the subagent to force-clean (when the id is unknown)" })),
        surface: Type.Optional(Type.String({ description: "Mux surface id (pane id) to close directly — use for orphaned panes/tabs with no running entry, e.g. the surface reported by subagents_status" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentCleanup(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ? `${args.name}` : "stalled";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — cleanup"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "cleaned") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(String(details.count ?? ""))) +
              theme.fg("dim", " — cleaned"),
            0,
            0,
          );
        }
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_status tool ──
  if (shouldRegister("subagents_status"))
    pi.registerTool({
      name: "subagents_status",
      label: "Subagent Status",
      description:
        "List every subagent that still has a pane open or a process alive: tracked running entries (id, name, " +
        "status kind starting/active/waiting/stalled, elapsed, task), orphaned pi processes that lost their running " +
        "entry (e.g. after an orchestrator restart), labeled panes that report a live agent this session does not " +
        "track (`foreign` — another pi session's agent, e.g. a nested orchestrator's subagent; NEVER clean these up " +
        "from here), and labeled panes with no live agent detected (`orphan`, left behind by failed launches).\n" +
        "`stalled` means no activity update for ~1 minute — a slow start, a long tool call, or a provider stall all " +
        "look the same. It is not proof of death: never interrupt or clean up an entry over a status line; results " +
        "are delivered automatically when a subagent exits.\n" +
        "Read-only snapshot for when you actually need to look (the user asked, or before steering/cleanup) — never " +
        "call it in a loop to watch a run: subagents are async and results arrive automatically. " +
        "`foreign`/`orphan` entries cannot be interrupted or steered from this session. NOT subagents_list (that " +
        "lists agent templates). Pane liveness needs backend support (herdr `agent_status`); without it such panes " +
        "are reported as `orphan` with a caveat, and orphaned processes are still detected via the process table.",
      promptSnippet:
        "Read-only snapshot of subagents still present: tracked entries plus `foreign` live panes (another session's agents — do not clean up) and `orphan` panes/processes. NOT the agent-template list (subagents_list). Never call this in a loop to watch a run — subagents are async and results arrive automatically; call it once when the user asks or before steering/cleanup. A `stalled` entry may still be working — never interrupt or clean up over it.",
      parameters: Type.Object({}),

      async execute() {
        return handleSubagentsStatus();
      },

      renderCall(_args, theme) {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold("subagent status")) +
            theme.fg("dim", " — query"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.count) {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(String(details.count))) +
              theme.fg("dim", " — present"),
            0,
            0,
          );
        }
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_choose_model tool ──
  if (shouldRegister("subagent_choose_model"))
    pi.registerTool({
      name: "subagent_choose_model",
      label: "Choose Subagent Model",
      description:
        "Ask a classifier model which model tier and thinking level a subagent you are about to spawn should use. " +
        "Tiers come from `modelPresets` in config.json (fast/balance/smart, ...); a preset that pins its own `thinking` uses it as is, otherwise the classifier picks the level (clamped to what the chosen tier's model actually supports). " +
        "Returns the ready-to-use value — e.g. `balance:high` — to pass as the `model` parameter of the `subagent` tool, which then selects the balance preset with thinking level high. " +
        "Costs one classifier call; use it when the model choice is not obvious, then spawn with the returned value. " +
        "It does NOT spawn anything and does not pick the task's content.",
      promptSnippet:
        "Pick a `modelPresets` tier + thinking level for a subagent via a classifier model; returns the `model: \"<preset>:<thinking>\"` value to pass to `subagent`.",
      promptGuidelines: [
        "Call subagent_choose_model when the right model tier/thinking level for a spawn is not obvious, then pass its returned `modelParam` (e.g. \"balance:high\") as the `model` parameter of the `subagent` tool.",
        "Pass the SAME task text you will give the `subagent` tool (scope, deliverable, invariants) — a condensed summary is thinner than the prompt the subagent receives, and the tier decision is only as good as that text.",
        "subagent_choose_model needs `modelPresets` in config.json and a classifier model (configured `classifierModel`, else the first available one). It costs one classifier call — never call it in a loop.",
      ],
      parameters: Type.Object({
        task: Type.String({
          description:
            "The task/prompt you intend to give the subagent — pass the SAME text you will hand to `subagent`, not a summary. This text is what the classifier judges, so a one-line version makes the decision worse: keep the scope, the deliverable, and the specific invariants or risks.",
        }),
        agent: Type.Optional(
          Type.String({
            description:
              "Agent template you plan to spawn (e.g. \"worker\"); its description is passed to the classifier for context.",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description:
              "How much surface the task covers, in your own words with numbers where you have them — e.g. \"71 GET routes\", \"1 controller + its service\", \"whole repo\". This is the strongest size signal the classifier gets; without it a 71-route sweep and a single-route check look alike.",
          }),
        ),
        risk: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
            description:
              "How costly a wrong answer would be: `low` = caught immediately by a command or test, `medium` = caught during the work, `high` = it can look right and needs verification against source/invariants.",
          }),
        ),
        deliverable: Type.Optional(
          Type.Union([Type.Literal("report"), Type.Literal("docs"), Type.Literal("code")], {
            description: "What the subagent produces: a read-only report, documentation/model edits, or code changes.",
          }),
        ),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let config: ModelPresetConfig;
        try {
          config = loadModelPresetConfig({ cwd: ctx?.cwd ?? process.cwd() });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: detail }],
            details: { error: detail },
          };
        }
        const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
        const registry = (ctx as { modelRegistry?: ModelRegistryLike } | undefined)?.modelRegistry;

        // Classifier decisions are observable: one line per request in the
        // session's classifier-decisions.jsonl, plus a UI notification.
        const sessionManager = (
          ctx as
            | {
                sessionManager?: {
                  getSessionDir(): string;
                  getSessionId(): string;
                  getSessionFile?(): string | undefined;
                };
              }
            | undefined
        )?.sessionManager;
        const observer = makeClassifierObserver({
          ...(sessionManager
            ? {
                artifactDir: getArtifactDir(
                  sessionManager.getSessionDir(),
                  sessionManager.getSessionId(),
                ),
              }
            : {}),
          ...(ctx?.ui ? { notify: (message, type) => ctx.ui.notify(message, type) } : {}),
        });

        const sessionFile = sessionManager?.getSessionFile?.() ?? null;
        const outcome = await chooseSubagentModel({
          registry,
          config,
          agentName: params.agent,
          agentDescription: agentDefs?.description,
          task: params.task,
          context: {
            ...classifierContext({
              task: params.task,
              agentDefs,
              cwd: ctx?.cwd,
              parentModel: sessionFile ? resolveParentModel(sessionFile) : null,
            }),
            ...(params.scope ? { scope: params.scope } : {}),
            ...(params.risk ? { risk: params.risk } : {}),
            ...(params.deliverable ? { deliverable: params.deliverable } : {}),
          },
          signal,
          observer,
        });

        if (!outcome.ok) {
          return {
            content: [{ type: "text", text: outcome.error }],
            details: { error: outcome.error },
          };
        }

        const choice = outcome.choice;
        const presetP = formatProbability(choice.presetProbabilities, choice.preset);
        const lines = [
          `Classifier ${choice.classifier.provider}/${choice.classifier.modelId} picked preset "${choice.preset}"${presetP}` +
            (choice.thinking
              ? ` with thinking "${choice.thinking}"${formatProbability(choice.thinkingProbabilities, choice.thinking)}`
              : " and no thinking level"),
          `Pass to subagent: model: "${choice.modelParam}"`,
          `Preset model: ${choice.model}`,
        ];
        if (choice.supportedThinkingLevels) {
          lines.push(`Model thinking levels: ${choice.supportedThinkingLevels.join(", ")}`);
        }
        if (!choice.modelResolved) {
          lines.push(
            "The preset model was not found in the model catalog, so the classified thinking level was kept as is.",
          );
        } else if (choice.thinkingClamped) {
          lines.push("The classified thinking level was clamped to what the model supports.");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { ...choice },
        };
      },

      renderCall(args, theme) {
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const preview = (args.task ?? "").split("\n").find((line: string) => line.trim()) ?? "";
        let text = theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold("choose model")) + agent;
        if (preview) {
          text += "\n" + theme.fg("toolOutput", preview.length > 100 ? preview.slice(0, 100) + "…" : preview);
        }
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.modelParam) {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(String(details.preset))) +
              theme.fg("dim", ` → ${details.modelParam}`),
            0,
            0,
          );
        }

        const text = resultText(result);
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });
  // ── subagents_list tool ──

  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List the AVAILABLE subagent templates (worker, scout, reviewer, researcher, ...) that can be passed to the " +
        "subagent tool's agent parameter. Scans project-local .pi/agents/ and global ~/.pi/agent/agents/; project-local " +
        "agents override global ones with the same name. " +
        "This does NOT report which subagents are currently running — spawned subagents deliver their result " +
        "automatically when they finish, so never poll this (or anything else) to check on a running subagent.",
      promptSnippet:
        "List available subagent templates for the subagent tool's agent parameter (NOT a status check — running subagents deliver results automatically).",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        // Resolve preset-backed models so the listing shows the model a spawn
        // would actually use, e.g. `[smart → anthropic/claude-opus-4-1]`.
        const modelPresets = loadModelPresetConfig({ cwd: ctx?.cwd ?? process.cwd() });
        const agents = list.map((agent) => ({
          ...agent,
          resolvedModel: formatModelBadge(agent.model, modelPresets),
        }));

        const lines = agents.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.resolvedModel ? ` [${a.resolvedModel}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const modelText = a.resolvedModel ?? a.model;
          const model = modelText ? theme.fg("dim", ` [${modelText}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



/**
 * pi greets a resumed session whose recorded working directory no longer
 * exists with an interactive Continue/Cancel prompt. Our launches are
 * unattended, so watch the pane briefly and confirm "Continue" (Enter) for
 * the user; the session then continues in the directory we launched it in.
 */
async function autoConfirmMissingSessionCwd(surface: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let screen = "";
    try {
      screen = readScreen(surface, 40);
    } catch {
      continue; // Pane not readable yet — keep watching.
    }
    if (/continue in current cwd|cwd from session file does not exist/i.test(screen)) {
      try {
        sendEnter(surface);
      } catch {
        // The pane may have vanished; nothing else to do.
      }
      return;
    }
  }
}

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer surface — use it to re-attach to a cancelled/orphaned " +
        "sub-agent or to give a finished one follow-up work (the session path is printed in the subagent's result " +
        "message: `Session: <path>` / `Resume: <pi command> --session <path>`). " +
        "Surface placement mirrors subagent spawning: `mux: \"pane\"` (default) splits a pane; `mux: \"tab\"` opens a tab. " +
        "When the session's recorded working directory is a herdr Git worktree that still exists, the resumed session " +
        "lands back in that worktree's own workspace (reusing the fresh root pane / opening a tab when already open) " +
        "and runs inside the worktree directory. When that repository has CodeGraph enabled, the worktree's index " +
        "is prepared (`codegraph init`/`sync`) before the session resumes (failures only add a warning). " +
        "Fire-and-forget async, exactly like the subagent tool: the call returns immediately; when the resumed session " +
        "finishes, its result arrives automatically as a steer message. Do not poll or babysit it — no repeated " +
        "subagents_status calls, sleep/wait loops, or file tailing; watching cannot make it finish sooner. Query " +
        "subagents_status only when the user explicitly asks about its current status. " +
        "The name parameter here is only the terminal tab label — it does NOT select a running subagent.",
      promptSnippet:
        "Resume a previous sub-agent session (from the `Session:` path in its result) in a new mux pane; async fire-and-forget, results arrive automatically — do not poll its status (only for an explicit user request).",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        mux: Type.Optional(
          Type.Union([Type.Literal("pane"), Type.Literal("tab")], {
            description:
              "Surface mode for the resumed session: \"pane\" (default) splits a pane; \"tab\" opens a tab " +
              "(in the spawning agent's workspace, or in the session's original worktree workspace when detected).",
          }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        // Bring the resumed session back to its original checkout when it
        // still exists, and — when that checkout is a herdr worktree — reuse
        // the worktree's own workspace with the same fresh/already-open
        // placement model as the `worktree` spawn parameter.
        const sessionCwd = getSessionCwd(params.sessionPath);
        const sessionCwdUsable = sessionCwd !== undefined && existsSync(sessionCwd);
        let resumeWorktree: HerdrWorktreeContext | undefined;
        if (sessionCwdUsable) {
          const found = await findWorktreeContextByPath(sessionCwd, {
            onCodegraphPrepare: (action, worktreePath) =>
              ctx.ui.notify(`Preparing CodeGraph index (codegraph ${action}) in ${worktreePath}…`, "info"),
          });
          if (found.ok) resumeWorktree = found.context;
        }
        const effectiveCwd = resumeWorktree?.path ?? (sessionCwdUsable ? sessionCwd : undefined);

        const surface = createSurface(name, {
          mode: params.mux ?? "pane",
          worktree: resumeWorktree
            ? {
                workspaceId: resumeWorktree.workspaceId,
                rootPane: resumeWorktree.rootPane,
                rootTabId: resumeWorktree.rootTabId,
                fresh: resumeWorktree.openedByUs,
              }
            : undefined,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        // Build pi resume command
        const parts = [resolvePiCommand().command, "--session", shellEscape(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });
        const steerFile = getSubagentSteerFile(artifactDir, id);
        mkdirSync(dirname(steerFile), { recursive: true });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, params.message, "utf8");
          parts.push(shellEscape(`@${resumeMsgFile}`));
        }

        // Build env prefix — propagate PI_CODING_AGENT_DIR for config isolation
        const resumeEnvParts: string[] = [];
        if (process.env.PI_CODING_AGENT_DIR) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        resumeEnvParts.push(`PI_SUBAGENT_STEER_FILE=${shellEscape(steerFile)}`);
        if (resumeWorktree) {
          resumeEnvParts.push(`PI_SUBAGENT_WORKTREE_WORKSPACE=${shellEscape(resumeWorktree.workspaceId)}`);
          resumeEnvParts.push(`PI_SUBAGENT_WORKTREE_ROOT_PANE=${shellEscape(resumeWorktree.rootPane)}`);
          resumeEnvParts.push(`PI_SUBAGENT_WORKTREE_REAP=${resumeWorktree.openedByUs ? "1" : "0"}`);
        }
        if (autoExit) {
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
        }
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
        const command = `${cdPrefix}${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${params.sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        // The session's original directory is gone — pi will ask Continue vs
        // Cancel on startup. Nobody is watching the pane, so confirm Continue.
        if (sessionCwd !== undefined && !sessionCwdUsable) {
          void autoConfirmMissingSessionCwd(surface).catch(() => {});
        }

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          steerFile,
          ...(resumeWorktree
            ? {
                worktree: {
                  workspaceId: resumeWorktree.workspaceId,
                  rootPane: resumeWorktree.rootPane,
                  reap: resumeWorktree.openedByUs,
                },
              }
            : {}),
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();

            if (result.ping) {
              const sessionRef = formatResumeHint(params.sessionPath);
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    sessionFile: params.sessionPath,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const presentation = resolveResultPresentation(
              { ...result, summary, sessionFile: params.sessionPath },
              name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: params.message ?? "resumed session",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                  piCommand: resolvePiCommand().command,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        const resumeCodegraphWarning = resumeWorktree?.codegraph?.warning;
        return {
          content: [
            {
              type: "text",
              text:
                `Session "${name}" resumed.` +
                (resumeCodegraphWarning ? `\n\nWarning: ${resumeCodegraphWarning}` : ""),
            },
          ],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            launchScriptFile,
            ...(resumeWorktree?.codegraph && resumeWorktree.codegraph.action !== "skip"
              ? { codegraph: resumeWorktree.codegraph }
              : {}),
            status: "started",
          },
        };
      },
    });


  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            const piCommand =
              typeof details.piCommand === "string" && details.piCommand.length > 0
                ? details.piCommand
                : DEFAULT_PI_COMMAND;
            contentLines.push(theme.fg("dim", `Resume:  ${piCommand} --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
