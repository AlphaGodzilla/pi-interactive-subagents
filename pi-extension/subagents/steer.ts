/**
 * Steering-message inbox shared between the parent orchestrator and a running
 * Pi-backed subagent.
 *
 * The parent appends JSON lines to a per-child inbox file (sidecar pattern,
 * mirroring the activity snapshots in activity.ts). The child's
 * subagent-done.ts extension polls that file and injects each message into its
 * session via pi.sendUserMessage(msg, { deliverAs: "steer" }):
 *   - child streaming / executing tools → interrupts after the current tool
 *     execution and the message arrives as a user message in its conversation;
 *   - child idle at the prompt → starts a new turn with the message.
 *
 * The child must opt in by having PI_SUBAGENT_STEER_FILE set (only children
 * launched by the orchestrator get it). Subagent-done.ts is only loaded into
 * child processes via `-e`, but even if it ran in the main session, the poller
 * never starts without that env var — mirroring how caller_ping and the
 * activity recorder already guard on subagent env vars.
 *
 * Concurrency: appendSteerMessage() appends while drainSteerMessages() claims
 * the whole file with an atomic rename, so a parent append that lands during a
 * claim starts a fresh file and is picked up on the next poll — no message is
 * lost or delivered twice.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SteerMessage {
  /** ISO timestamp of when the parent enqueued the message. */
  sentAt: string;
  /** Who enqueued it (defaults to "parent"). */
  from?: string;
  /** The steering message text, delivered verbatim as a user message. */
  message: string;
}

/** Per-child inbox path: <artifactDir>/subagent-steer/<runningChildId>.jsonl */
export function getSubagentSteerFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-steer", `${runningChildId}.jsonl`);
}

/** Parent side: enqueue one steering message for a running child. */
export function appendSteerMessage(
  steerFile: string,
  message: string,
  from = "parent",
): void {
  mkdirSync(dirname(steerFile), { recursive: true });
  appendFileSync(
    steerFile,
    JSON.stringify({ sentAt: new Date().toISOString(), from, message }) + "\n",
    "utf8",
  );
}

function parseSteerLine(line: string): SteerMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<SteerMessage>;
    if (typeof parsed.message === "string") {
      return {
        sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : "",
        ...(typeof parsed.from === "string" ? { from: parsed.from } : {}),
        message: parsed.message,
      };
    }
  } catch {
    // Malformed line — skip rather than wedge the whole inbox.
  }
  return null;
}

/**
 * Child side: atomically claim and drain all pending messages, in order.
 *
 * The rename makes the claim safe against a concurrent parent append: messages
 * appended after the rename land in a fresh file and are drained on the next
 * poll instead of being lost or delivered twice.
 */
export function drainSteerMessages(steerFile: string): SteerMessage[] {
  const claimFile = `${steerFile}.claim`;
  try {
    renameSync(steerFile, claimFile);
  } catch {
    // Nothing pending (or a transient fs error) — retry on the next poll.
    return [];
  }

  let raw: string;
  try {
    raw = readFileSync(claimFile, "utf8");
  } catch {
    // Read failed — roll the claim back so no message is lost.
    try {
      renameSync(claimFile, steerFile);
    } catch {
      rmSync(claimFile, { force: true });
    }
    return [];
  }
  rmSync(claimFile, { force: true });

  return raw
    .split("\n")
    .map(parseSteerLine)
    .filter((entry): entry is SteerMessage => entry !== null);
}

export interface SteerPoller {
  /** Deliver any pending messages; returns the number drained from the inbox. */
  poll(): number;
}

/**
 * Child-side poller factory. Pure glue: interval management is left to the
 * caller (subagent-done.ts owns a reload-safe interval), so this is unit
 * testable with a mock delivery sink.
 *
 * At most one message is delivered per poll: pi can only accept one prompt at
 * a time, and spacing deliveries by the poll interval avoids racing the turn
 * that the previous message just started. Remaining messages are requeued in
 * order and delivered on subsequent polls.
 */
export function createSteerPoller(options: {
  steerFile: string;
  /** Delivery sink; typically (msg) => pi.sendUserMessage(msg, { deliverAs: "steer" }) */
  sendUserMessage: (message: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
}): SteerPoller {
  const { steerFile, sendUserMessage } = options;

  function poll(): number {
    const pending = drainSteerMessages(steerFile);
    if (pending.length === 0) return 0;
    for (const entry of pending.slice(1)) {
      appendSteerMessage(steerFile, entry.message, entry.from ?? "parent-requeue");
    }
    try {
      sendUserMessage(pending[0].message, { deliverAs: "steer" });
    } catch {
      // sendUserMessage failures are surfaced by the pi runtime (emitError);
      // nothing actionable here.
    }
    return pending.length;
  }

  return { poll };
}
