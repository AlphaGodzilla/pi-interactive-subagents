/**
 * CodeGraph index preparation for worktree placements.
 *
 * A repository is considered "codegraph enabled" when its MAIN checkout
 * carries a `.codegraph` directory (the index lives outside git, so freshly
 * created worktrees never inherit it) and the `codegraph` CLI is available on
 * PATH. When enabled, the worktree checkout's index is made ready before the
 * sub-agent starts:
 *
 * - `codegraph init` when the checkout has no index yet (every freshly
 *   created worktree, and older worktrees from before codegraph was enabled),
 * - `codegraph sync` when the checkout already carries a `.codegraph` index.
 *
 * The spawn awaits this step (it runs before the sub-agent starts) but it is
 * best-effort: a failure or timeout becomes a warning the caller surfaces; it
 * never fails the spawn itself. `codegraph` is *not* installed by this extension.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Upper bound for one codegraph command. `init` builds the initial index of
 * the whole checkout and can legitimately take minutes on a large repo; a
 * hung CLI beyond this is treated as a failed preparation.
 */
export const CODEGRAPH_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export type CodegraphAction = "init" | "sync";

/** Which command a worktree checkout needs, or that codegraph is not enabled. */
export type CodegraphPlan = { action: CodegraphAction } | { action: "skip"; reason: string };

export interface CodegraphPreparation {
  /** Command that was attempted, or "skip" when codegraph is not enabled. */
  action: CodegraphAction | "skip";
  /** Set when `action === "skip"`: why there was nothing to do. */
  reason?: string;
  /** Set when a command was attempted and failed: compact message for the user/model. */
  warning?: string;
}

export interface CodegraphPreparationInput {
  /** Main checkout root — the `.codegraph` marker is looked up here. */
  mainCheckoutPath: string;
  /** Worktree checkout whose index is prepared. */
  worktreePath: string;
  /** Override the CLI lookup (tests). */
  hasCommand?: (command: string) => boolean;
  /** Override the command runner (tests). Throwing means "command failed". */
  run?: (command: string, args: string[], options: { cwd: string; timeout: number }) => void | Promise<void>;
  /**
   * Called right before the blocking command runs — lets the caller surface
   * progress (e.g. a UI notification) while the spawn waits.
   */
  onPrepare?: (action: CodegraphAction) => void;
  timeoutMs?: number;
}

/** Whether an executable named `command` is reachable through PATH. */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Not in this directory (or not executable) — keep scanning.
    }
  }
  return false;
}

/** Pure: pick the step a worktree checkout needs. Exported for tests. */
export function planCodegraphPreparation(input: {
  codegraphOnPath: boolean;
  mainCheckoutHasIndex: boolean;
  worktreeHasIndex: boolean;
}): CodegraphPlan {
  if (!input.codegraphOnPath) {
    return { action: "skip", reason: "the codegraph CLI is not on PATH" };
  }
  if (!input.mainCheckoutHasIndex) {
    return { action: "skip", reason: "the main checkout has no .codegraph directory" };
  }
  return { action: input.worktreeHasIndex ? "sync" : "init" };
}

/** Describe an indexing failure compactly: the CLI's own output beats a stack. */
function describeFailure(error: unknown): string {
  const anyError = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof anyError?.stderr === "string" ? anyError.stderr.trim() : "";
  const stdout = typeof anyError?.stdout === "string" ? anyError.stdout.trim() : "";
  const detail = stderr || stdout || String(anyError?.message ?? error);
  return detail.split("\n").slice(-3).join(" | ").slice(0, 300);
}

/** Run one codegraph command against `worktreePath`; resolves when it finishes. */
async function defaultRun(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<void> {
  // Async execFile (not the *Sync* variant): the spawn waits for this command,
  // but the event loop does not — a multi-minute `init` must not freeze the TUI.
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        encoding: "utf8",
        // stdin ignored: `--yes` already suppresses prompts, and a CLI that
        // still asks something must fail fast instead of hanging the spawn.
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/**
 * Bring the CodeGraph index of `worktreePath` up to date when the repo has
 * codegraph enabled. Never throws: failures come back as `warning`.
 */
export async function prepareCodegraphForWorktree(input: CodegraphPreparationInput): Promise<CodegraphPreparation> {
  const plan = planCodegraphPreparation({
    codegraphOnPath: (input.hasCommand ?? commandOnPath)("codegraph"),
    mainCheckoutHasIndex: existsSync(join(input.mainCheckoutPath, ".codegraph")),
    worktreeHasIndex: existsSync(join(input.worktreePath, ".codegraph")),
  });
  if (plan.action === "skip") return plan;

  // Pass the checkout explicitly so the CLI can never fall back to a parent
  // project if it is run from an unexpected location.
  const args = plan.action === "init" ? ["init", "--yes", input.worktreePath] : ["sync", input.worktreePath];
  try {
    input.onPrepare?.(plan.action);
    const run = input.run ?? defaultRun;
    await run("codegraph", args, { cwd: input.worktreePath, timeout: input.timeoutMs ?? CODEGRAPH_COMMAND_TIMEOUT_MS });
    return { action: plan.action };
  } catch (error) {
    return {
      action: plan.action,
      warning: `codegraph ${plan.action} failed for ${input.worktreePath}: ${describeFailure(error)}`,
    };
  }
}
