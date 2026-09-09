/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Shift+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 * - Provides `caller_ping` (child → parent help requests)
 * - Drains the steering-message inbox so the parent can redirect a running child
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import { createSteerPoller, type SteerPoller } from "./steer.ts";

// Survive /reload: the previous module instance may still hold a running
// steer-inbox interval. /reload re-imports this file, so clear it at load.
const STEER_INTERVAL_KEY = Symbol.for("pi-subagents/steer-interval");
{
  const prevInterval = (globalThis as any)[STEER_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[STEER_INTERVAL_KEY] = null;
  }
}

/**
 * Decide whether the steer-inbox poller should run for this process.
 *
 * The poller is strictly opt-in: it only starts when the orchestrator passed
 * PI_SUBAGENT_STEER_FILE (and the child session env var is present). Without
 * them — e.g. if this extension were loaded into the main agent session —
 * steering is fully inert, mirroring how caller_ping and the activity recorder
 * already guard on subagent env vars.
 */
export function resolveSteerPolling(env: {
  PI_SUBAGENT_SESSION?: string;
  PI_SUBAGENT_STEER_FILE?: string;
}): { enabled: boolean; steerFile: string | null } {
  const session = env.PI_SUBAGENT_SESSION?.trim();
  const steerFile = env.PI_SUBAGENT_STEER_FILE?.trim();
  return session && steerFile ? { enabled: true, steerFile } : { enabled: false, steerFile: null };
}

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  // Steering-message inbox (subagent_steer tool on the parent side).
  // Strictly opt-in: the poller only exists when the orchestrator passed
  // PI_SUBAGENT_STEER_FILE. Without it — including when this extension is
  // loaded into the main agent session — steering stays fully inert.
  const steerConfig = resolveSteerPolling(process.env as Record<string, string | undefined>);
  const steerPoller: SteerPoller | null = steerConfig.enabled && steerConfig.steerFile
    ? createSteerPoller({
        steerFile: steerConfig.steerFile,
        sendUserMessage: (message, options) => pi.sendUserMessage(message, options),
      })
    : null;

  function startSteerPolling(): void {
    if (!steerPoller) return;
    const existing = (globalThis as any)[STEER_INTERVAL_KEY] as ReturnType<typeof setInterval> | null;
    if (existing) return; // already polling (session_start can fire again after a reload)
    steerPoller.poll(); // deliver anything that arrived before the interval started
    (globalThis as any)[STEER_INTERVAL_KEY] = setInterval(() => steerPoller.poll(), 500);
  }

  function stopSteerPolling(): void {
    const existing = (globalThis as any)[STEER_INTERVAL_KEY] as ReturnType<typeof setInterval> | null;
    if (existing) {
      clearInterval(existing);
      (globalThis as any)[STEER_INTERVAL_KEY] = null;
    }
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Shift+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Shift+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;

  // When the last agent run ends with stopReason="error", pi's agent loop
  // may still retry it (exponential backoff, settings.retry) AFTER agent_end.
  // Auto-exit must not shut down on that first error turn — that killed the
  // child before a single retry could run. Defer the error exit until
  // agent_settled, which fires once the run (including every retry) is over.
  let deferredErrorExit: SubagentErrorInfo | null = null;
  let agentStarted = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    // Active tools only — getAllTools() would list never-activated
    // cross-platform built-ins (e.g. powershell on macOS) as available.
    toolNames = pi.getActiveTools().sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
    startSteerPolling();
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // A stopReason="error" turn is NOT the end of the run: pi's agent loop
      // retries provider errors with exponential backoff (settings.retry)
      // AFTER agent_end, before the run settles. Exiting here — as auto-exit
      // used to — killed the child on the FIRST provider error, so subagents
      // never got to use pi's retry budget and died on a single transient
      // 502/5xx. Defer the error exit until agent_settled.
      const errorInfo = findLatestAssistantError(messages);
      if (errorInfo) {
        deferredErrorExit = errorInfo;
        recorder.agentEndWaiting();
        return;
      }
      deferredErrorExit = null;
      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  // agent_settled fires once the run is fully over — including every retry the
  // agent loop took after an error turn (or the immediate end when the error
  // was not retryable). An error exit still pending here means pi gave up:
  // surface the real failure to the parent via the .exit sidecar and shut
  // down. If the user took over the pane meanwhile, leave the session open.
  pi.on("agent_settled", (event, ctx) => {
    if (!deferredErrorExit) return;
    const errorInfo = deferredErrorExit;
    deferredErrorExit = null;
    if (userTookOver) return;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      try {
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({
            type: "error",
            errorMessage: errorInfo.errorMessage,
            stopReason: errorInfo.stopReason,
          }),
        );
      } catch {
        // Best effort — even without the sidecar, the watcher's session-file
        // fallback can still recover the errorMessage.
      }
    }
    recorder.agentEndDone();
    ctx.shutdown();
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    stopSteerPolling();
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Shift+J (ctrl+j alone is pi built-in newline)
  pi.registerShortcut("ctrl+shift+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
