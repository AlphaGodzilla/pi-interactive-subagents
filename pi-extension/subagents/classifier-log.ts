import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ClassifierDecision } from "./model-classifier.ts";

/**
 * File the classifier (decision model) requests are recorded to, one JSON
 * object per line, inside the session's artifact directory:
 *   <sessionDir>/artifacts/<session-id>/classifier-decisions.jsonl
 *
 * Every decision request is observable — what was asked, which model answered,
 * the probabilities, the resulting choice, how long it took, and any error —
 * for both `subagent_choose_model` and the spawn-time thinking decision.
 */
export const CLASSIFIER_DECISION_LOG_FILE = "classifier-decisions.jsonl";

export function classifierDecisionLogPath(artifactDir: string): string {
  return join(artifactDir, CLASSIFIER_DECISION_LOG_FILE);
}

/**
 * Append one record. Best effort: logging must never break a spawn or a tool
 * call, so failures are swallowed and reported as `undefined`.
 */
export function appendClassifierDecision(
  artifactDir: string,
  decision: ClassifierDecision,
): string | undefined {
  const path = classifierDecisionLogPath(artifactDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(decision)}\n`, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/** One-line summary for the UI notification. */
export function describeClassifierDecision(decision: ClassifierDecision): string {
  const who = decision.classifier
    ? `${decision.classifier.provider}/${decision.classifier.modelId}`
    : "no classifier";
  const timing = `${decision.durationMs}ms`;

  if (decision.error) {
    return `classifier ${who} — ${decision.error} (${timing})`;
  }

  // The tool's completing record is about the model it hands back.
  if (decision.kind === "choose-thinking") {
    return `model: ${decision.decision.modelParam ?? "?"} · ${who} · ${timing}`;
  }

  if (decision.kind === "thinking") {
    const level = decision.decision.thinking;
    const clamped = decision.decision.clamped === true ? " (clamped)" : "";
    const target = decision.decision.model ? ` for ${decision.decision.model}` : "";
    return `thinking: ${level ?? "none"}${clamped}${target} · ${who} · ${timing}`;
  }

  const preset = decision.decision.preset;
  const modelParam = decision.decision.modelParam;
  // Surface an escalation-policy hold: the classifier's pick was not applied.
  const requested = decision.decision.requestedPreset;
  const held = requested && requested !== preset ? ` (held; classifier asked ${String(requested)})` : "";
  return `model: ${modelParam ?? preset ?? "?"}${held} · ${who} · ${timing}`;
}
