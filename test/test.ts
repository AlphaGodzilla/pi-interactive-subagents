import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@mariozechner/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  getSessionCwd,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";

import {
  shellEscape,
  isCmuxAvailable,
  isWezTermAvailable,
  isHerdrAvailable,
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
  buildHerdrTabCreateArgs,
  pickWorktreeByPath,
  parseHerdrTabCreateOutput,
  resolveSurfaceRequest,
  buildWorktreeTargetPath,
  pickExistingWorktree,
  parseWorktreeCommandOutput,
  canSplitZellijPane,
  predictZellijSplitDirection,
  selectZellijPlacement,
  selectZellijStackPlacement,
} from "../pi-extension/subagents/cmux.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  resolveSteerPolling,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneDefault, { hasRunningSubagents } from "../pi-extension/subagents/subagent-done.ts";
import {
  appendSteerMessage,
  createSteerPoller,
  drainSteerMessages,
  getSubagentSteerFile,
} from "../pi-extension/subagents/steer.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/cmux.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
      getActiveTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  it("reads the cwd from a session header and tolerates bad input", () => {
    withTempDir((dir) => {
      const full = join(dir, "full.jsonl");
      writeFileSync(
        full,
        JSON.stringify({ type: "session", version: 3, cwd: "/repo/proj-wt-1" }) + "\n" + '{"type":"model_change"}\n',
      );
      assert.equal(getSessionCwd(full), "/repo/proj-wt-1");

      const noCwd = join(dir, "no-cwd.jsonl");
      writeFileSync(noCwd, '{"type":"session","version":3}\n');
      assert.equal(getSessionCwd(noCwd), undefined);

      const broken = join(dir, "broken.jsonl");
      writeFileSync(broken, "not-json\n");
      assert.equal(getSessionCwd(broken), undefined);

      assert.equal(getSessionCwd(join(dir, "missing.jsonl")), undefined);
    });
  });

  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads mux mode from frontmatter and defaults to pane", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "mux-tab-test-agent",
        ["name: mux-tab-test-agent", "model: anthropic/test-mux-tab", "mux: tab"].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "mux-pane-test-agent",
        ["name: mux-pane-test-agent", "model: anthropic/test-mux-pane", "mux: pane"].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "mux-unset-test-agent",
        ["name: mux-unset-test-agent", "model: anthropic/test-mux-unset"].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "mux-invalid-test-agent",
        ["name: mux-invalid-test-agent", "model: anthropic/test-mux-invalid", "mux: split"].join("\n"),
      );

      assert.equal(testApi.loadAgentDefaults("mux-tab-test-agent")?.mux, "tab");
      assert.equal(testApi.loadAgentDefaults("mux-pane-test-agent")?.mux, "pane");
      assert.equal(testApi.loadAgentDefaults("mux-unset-test-agent")?.mux, undefined);
      assert.equal(testApi.loadAgentDefaults("mux-invalid-test-agent")?.mux, undefined);
    });
  });

  it("resolves the effective mux mode with pane as the default", () => {
    assert.equal(testApi.resolveMuxMode(null), "pane");
    assert.equal(testApi.resolveMuxMode({}), "pane");
    assert.equal(testApi.resolveMuxMode({ mux: "pane" }), "pane");
    assert.equal(testApi.resolveMuxMode({ mux: "tab" }), "tab");
    assert.equal(testApi.parseMuxMode("TAB"), "tab");
    assert.equal(testApi.parseMuxMode(" pane "), "pane");
    assert.equal(testApi.parseMuxMode("window"), undefined);
  });

  it("honors tab requests and pins pane splits to the spawning parent's pane", () => {
    // A child that explicitly declares mux: tab still gets its own tab, even
    // when spawned from another tab-mode subagent.
    assert.deepEqual(
      resolveSurfaceRequest("tab", "herdr", {
        subagentSurface: "w1:p41",
        herdrPaneId: "w1:p41",
      }),
      { mode: "tab", parentSurface: "w1:p41" },
    );

    // Pane mode: the split targets the spawning parent's own pane, so a
    // subagent of a tab-mode subagent lands inside that same tab.
    assert.deepEqual(
      resolveSurfaceRequest("pane", "herdr", {
        subagentSurface: "w1:p41",
        herdrPaneId: "w1:p41",
      }),
      { mode: "pane", parentSurface: "w1:p41" },
    );

    // Parent surface (PI_SUBAGENT_SURFACE) wins over the mux pane env.
    assert.deepEqual(
      resolveSurfaceRequest("pane", "herdr", {
        subagentSurface: "w1:p9",
        herdrPaneId: "w1:p1",
      }),
      { mode: "pane", parentSurface: "w1:p9" },
    );

    // Non-herdr backends fall back to a pane split.
    assert.deepEqual(
      resolveSurfaceRequest("tab", "tmux", { tmuxPane: "%3" }),
      { mode: "pane", parentSurface: "%3" },
    );

    assert.deepEqual(
      resolveSurfaceRequest("pane", null, {}),
      { mode: "pane", parentSurface: undefined },
    );
  });

  it("derives the worktree target path and picks existing worktrees by name", () => {
    assert.equal(
      buildWorktreeTargetPath("/repo/my-project", "hotfix-issue-20"),
      "/repo/my-project-hotfix-issue-20",
    );

    const target = "/repo/my-project-hotfix-issue-20";
    const byPath = [{ path: target, branch: "other" }, { path: "/repo/elsewhere", label: "hotfix-issue-20" }];
    assert.equal(pickExistingWorktree(byPath, "hotfix-issue-20", target)?.path, target);

    const byLabel = [{ path: "/repo/weird-path", label: "hotfix-issue-20" }];
    assert.equal(pickExistingWorktree(byLabel, "hotfix-issue-20", target)?.label, "hotfix-issue-20");

    const byBranch = [{ path: "/repo/weird-path", branch: "hotfix-issue-20" }];
    assert.equal(pickExistingWorktree(byBranch, "hotfix-issue-20", target)?.branch, "hotfix-issue-20");

    const byBasename = [{ path: "/another/dir/my-project-hotfix-issue-20" }];
    assert.equal(pickExistingWorktree(byBasename, "hotfix-issue-20", target)?.path, "/another/dir/my-project-hotfix-issue-20");

    assert.equal(pickExistingWorktree([{ path: "/repo/main" }], "hotfix-issue-20", target), undefined);
  });

  it("picks a worktree by exact checkout path (trailing slash tolerated)", () => {
    const worktrees = [
      { path: "/repo/main" },
      { path: "/repo-probe-1", branch: "probe-1" },
      { path: "/repo-probe-2/", branch: "probe-2" },
    ];
    assert.equal(pickWorktreeByPath(worktrees, "/repo-probe-1")?.branch, "probe-1");
    assert.equal(pickWorktreeByPath(worktrees, "/repo-probe-2")?.branch, "probe-2");
    assert.equal(pickWorktreeByPath(worktrees, "/repo-probe-3"), undefined);
  });

  it("parses herdr worktree create/open output", () => {
    const output = JSON.stringify({
      id: "cli:worktree:create",
      result: {
        workspace: { workspace_id: "w7", label: "probe-wt-1" },
        tab: { tab_id: "w7:t1" },
        root_pane: { pane_id: "w7:p1" },
        worktree: { path: "/repo/proj-probe-wt-1", branch: "probe-wt-1" },
      },
    });
    assert.deepEqual(parseWorktreeCommandOutput(output), {
      workspaceId: "w7",
      rootPane: "w7:p1",
      rootTabId: "w7:t1",
      path: "/repo/proj-probe-wt-1",
      openedByUs: true,
    });

    // `already_open: true` (worktree open on a pre-existing workspace): the
    // user was already there, so the workspace must not be auto-reaped.
    const alreadyOpen = JSON.stringify({
      id: "cli:worktree:open",
      result: {
        already_open: true,
        workspace: { workspace_id: "w9" },
        root_pane: { pane_id: "w9:p1" },
        worktree: { path: "/repo/proj-wt" },
      },
    });
    assert.equal(parseWorktreeCommandOutput(alreadyOpen).openedByUs, false);

    assert.throws(() => parseWorktreeCommandOutput("not json"), /Unexpected herdr worktree output/);
    assert.throws(() => parseWorktreeCommandOutput("{}"), /Unexpected herdr worktree output/);
  });

  it("builds herdr tab-create args and parses its output", () => {
    assert.deepEqual(buildHerdrTabCreateArgs("Scout", "/tmp/work"), [
      "tab", "create", "--label", "Scout", "--cwd", "/tmp/work", "--no-focus",
    ]);
    // An explicit workspace keeps the tab in the spawning agent's workspace,
    // not the focused one.
    assert.deepEqual(buildHerdrTabCreateArgs("Scout", "/tmp/work", "w1"), [
      "tab", "create", "--workspace", "w1", "--label", "Scout", "--cwd", "/tmp/work", "--no-focus",
    ]);

    const output = JSON.stringify({
      id: "cli:tab:create",
      result: {
        root_pane: { pane_id: "w1:p3T" },
        tab: { tab_id: "w1:tJ", label: "Scout" },
      },
    });
    assert.equal(parseHerdrTabCreateOutput(output), "w1:p3T");
    assert.throws(() => parseHerdrTabCreateOutput("not json"), /Unexpected herdr tab create output/);
    assert.throws(() => parseHerdrTabCreateOutput("{}"), /Unexpected herdr tab create output/);
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("no bundled agents are shipped; previously bundled names are not discoverable", async () => {
    await withIsolatedAgentEnv(async () => {
      for (const name of ["worker", "scout", "reviewer", "planner"]) {
        assert.equal(
          testApi.loadAgentDefaults(name),
          null,
          `expected no bundled agent ${name} to be discoverable`,
        );
      }
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("auto-exit defers error exits until agent_settled (pi retry window)", () => {
    const AUTO_EXIT_KEY = "PI_SUBAGENT_AUTO_EXIT";
    const SESSION_KEY = "PI_SUBAGENT_SESSION";
    const NAME_KEY = "PI_SUBAGENT_NAME";
    let dir: string;
    let sessionFile: string;
    const savedEnv = new Map<string, string | undefined>();

    before(() => {
      for (const key of [AUTO_EXIT_KEY, SESSION_KEY, NAME_KEY]) savedEnv.set(key, process.env[key]);
      dir = mkdtempSync(join(tmpdir(), "pi-sub-done-"));
      sessionFile = join(dir, "child.jsonl");
      writeFileSync(sessionFile, "", "utf8");
      process.env[AUTO_EXIT_KEY] = "1";
      process.env[SESSION_KEY] = sessionFile;
      process.env[NAME_KEY] = "t-child";
    });
    after(() => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    });

    function createHarness() {
      const handlers = new Map<string, (event?: any, ctx?: any) => void>();
      const calls: string[] = [];
      const pi = {
        on: (name: string, fn: (event?: any, ctx?: any) => void) => handlers.set(name, fn),
        getAllTools: () => [],
        getActiveTools: () => [],
        registerShortcut: () => {},
        registerTool: () => {},
        sendUserMessage: async () => {},
        sendMessage: async () => {},
      };
      const ctx = {
        shutdown: () => calls.push("shutdown"),
        isIdle: () => true,
        ui: { setWidget: () => {} },
      };
      subagentDoneDefault(pi as any);
      return { handlers, ctx, calls };
    }

    function errorMessage(stopReason: string, errorMessage?: string) {
      return { role: "assistant", stopReason, errorMessage, content: [] };
    }

    it("does not exit on the first error agent_end; flushes .exit at agent_settled", () => {
      const { handlers, ctx, calls } = createHarness();
      const err = `502: {\"type\":\"api_error\",\"message\":\"Provider timed out\"}`;

      handlers.get("agent_end")?.({ type: "agent_end", messages: [errorMessage("error", err)] }, ctx);
      assert.deepEqual(calls, [], "must not shut down while pi may still retry");
      assert.equal(existsSync(sessionFile + ".exit"), false, "no sidecar before the run settles");

      handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      assert.deepEqual(calls, ["shutdown"]);
      const sidecar = JSON.parse(readFileSync(sessionFile + ".exit", "utf8"));
      assert.equal(sidecar.type, "error");
      assert.equal(sidecar.stopReason, "error");
      assert.equal(sidecar.errorMessage, err);
      rmSync(sessionFile + ".exit", { force: true });
    });

    it("shuts down shortly after a normal (non-error) agent_end", async () => {
      const { handlers, ctx, calls } = createHarness();
      handlers.get("agent_end")?.({ type: "agent_end", messages: [errorMessage("stop")] }, ctx);
      assert.deepEqual(calls, [], "exit is deferred one confirm window");
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.deepEqual(calls, ["shutdown"]);
    });

    it("stays open while spawned subagents are still running", async () => {
      const { handlers, ctx, calls } = createHarness();
      const saved = (globalThis as any).__piSubagentRunningRegistry;
      const registry = { size: 1 };
      (globalThis as any).__piSubagentRunningRegistry = registry;
      try {
        handlers.get("agent_end")?.({ type: "agent_end", messages: [errorMessage("stop")] }, ctx);
        await new Promise((resolve) => setTimeout(resolve, 450));
        assert.deepEqual(calls, [], "must not exit while a child subagent is running");

        // Child finished and the registry drained: the next normal agent_end exits.
        registry.size = 0;
        handlers.get("agent_end")?.({ type: "agent_end", messages: [errorMessage("stop")] }, ctx);
        await new Promise((resolve) => setTimeout(resolve, 450));
        assert.deepEqual(calls, ["shutdown"]);
      } finally {
        if (saved === undefined) delete (globalThis as any).__piSubagentRunningRegistry;
        else (globalThis as any).__piSubagentRunningRegistry = saved;
      }
    });

    it("detects running children from the shared registry", () => {
      const saved = (globalThis as any).__piSubagentRunningRegistry;
      try {
        delete (globalThis as any).__piSubagentRunningRegistry;
        assert.equal(hasRunningSubagents(), false);
        (globalThis as any).__piSubagentRunningRegistry = { size: 0 };
        assert.equal(hasRunningSubagents(), false);
        (globalThis as any).__piSubagentRunningRegistry = { size: 2 };
        assert.equal(hasRunningSubagents(), true);
        assert.equal(hasRunningSubagents({}), false);
      } finally {
        if (saved === undefined) delete (globalThis as any).__piSubagentRunningRegistry;
        else (globalThis as any).__piSubagentRunningRegistry = saved;
      }
    });

    it("keeps the session open when the user took over before agent_settled", () => {
      const { handlers, ctx, calls } = createHarness();
      handlers.get("agent_start")?.({}, ctx);
      handlers.get("input")?.({}, ctx); // user takeover
      handlers.get("agent_end")?.({ type: "agent_end", messages: [errorMessage("error", "boom")] }, ctx);
      handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      assert.deepEqual(calls, [], "user takeover must leave the session open");
      assert.equal(existsSync(sessionFile + ".exit"), false);
    });

    it("resets the deferred error when a later agent_end completes normally", async () => {
      const { handlers, ctx, calls } = createHarness();
      handlers.get("agent_end")?.({ type: "agent_end", messages: [errorMessage("error", "transient")] }, ctx);
      // pi retried and the run then completed normally
      handlers.get("agent_end")?.({ type: "agent_end", messages: [errorMessage("stop")] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.deepEqual(calls, ["shutdown"]);
      handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
      assert.deepEqual(calls, ["shutdown"], "no second exit after settle");
      assert.equal(existsSync(sessionFile + ".exit"), false, "no error sidecar after a successful retry");
    });
  });

  describe("resolveSteerPolling", () => {
    it("stays inert without subagent env vars (main agent session)", () => {
      // This is the guard that keeps the steer poller off in the main agent
      // session even if subagent-done.ts were loaded there.
      assert.deepEqual(resolveSteerPolling({}), { enabled: false, steerFile: null });
      assert.deepEqual(
        resolveSteerPolling({ PI_SUBAGENT_SESSION: "/tmp/x.jsonl" }),
        { enabled: false, steerFile: null },
      );
      assert.deepEqual(
        resolveSteerPolling({ PI_SUBAGENT_STEER_FILE: "/tmp/inbox.jsonl" }),
        { enabled: false, steerFile: null },
      );
    });

    it("enables polling only when the orchestrator passed the inbox path", () => {
      assert.deepEqual(
        resolveSteerPolling({
          PI_SUBAGENT_SESSION: "/tmp/child.jsonl",
          PI_SUBAGENT_STEER_FILE: "/tmp/child-steer.jsonl",
        }),
        { enabled: true, steerFile: "/tmp/child-steer.jsonl" },
      );
    });

    it("treats blank env values as absent", () => {
      assert.deepEqual(
        resolveSteerPolling({
          PI_SUBAGENT_SESSION: "  ",
          PI_SUBAGENT_STEER_FILE: "",
        }),
        { enabled: false, steerFile: null },
      );
    });
  });
});

describe("cmux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("decodes ping payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "need help" },
      },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("treats a shutdown payload (pi quit without subagent_done) as a normal end", () => {
    assert.deepEqual(interpretExitSidecar({ type: "shutdown" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("tool registration", () => {
  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("expands spawning false to deny subagent interruption", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_interrupt"), true);
    assert.equal(denied.has("subagent_resume"), true);
    assert.equal(denied.has("subagent_steer"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_resume with an autoExit override", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
    assert.ok(resumeTool, "expected subagent_resume tool to be registered");

    const autoExitSchema = resumeTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /Defaults to true/);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.subagentDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_interrupt in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), true);
  });

  it("documents the id-vs-name targeting rules in interrupt and steer tool descriptions", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    for (const toolName of ["subagent_interrupt", "subagent_steer"]) {
      const tool = registeredTools.find((t) => t.name === toolName);
      assert.ok(tool, `${toolName} registered`);
      // The id parameter must be described as the internal 8-hex id, and the
      // description must steer callers to the name field when the id is unknown
      // (models historically copied the display name into the id field).
      assert.match(tool.description, /8-hex id/);
      assert.match(tool.description, /Never put a display name into the id/);
      assert.match(tool.promptSnippet, /display name as id|name-as-id/);
    }

    const spawnTool = registeredTools.find((t) => t.name === "subagent");
    assert.match(spawnTool.description, /\[id /);
    assert.match(spawnTool.promptSnippet, /\[id /);

    const listTool = registeredTools.find((t) => t.name === "subagents_list");
    assert.match(listTool.description, /NOT.*currently running/);
  });

  it("resolves interrupt targets by exact id and reports name ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byId = testApi.resolveInterruptTarget({ id: "c3", name: "Worker" });
      assert.equal(byId.running.id, "c3");

      const ambiguous = testApi.resolveInterruptTarget({ name: "Worker" });
      assert.match(ambiguous.error, /Ambiguous subagent name/);
    } finally {
      runningMap.clear();
    }
  });

  it("falls back to display-name matching when the id field carries a name", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "reviewer-flyway-v110-v111-repair" }));

      // Models copy the display name into the id field when the internal hex
      // id is unknown (the historical failure mode).
      const viaIdAsName = testApi.resolveInterruptTarget({ id: "reviewer-flyway-v110-v111-repair" });
      assert.equal(viaIdAsName.running.id, "a1");

      const viaBoth = testApi.resolveInterruptTarget({
        id: "reviewer-flyway-v110-v111-repair",
        name: "reviewer-flyway-v110-v111-repair",
      });
      assert.equal(viaBoth.running.id, "a1");
    } finally {
      runningMap.clear();
    }
  });

  it("reports ambiguity and lists candidates when name-as-id matches several running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2" }));

      const ambiguous = testApi.resolveInterruptTarget({ id: "Worker" });
      assert.match(ambiguous.error, /Ambiguous subagent name/);
      assert.match(ambiguous.error, /\[a1\]/);
    } finally {
      runningMap.clear();
    }
  });

  it("lists running candidates when the target cannot be resolved", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1" }));

      const missing = testApi.resolveInterruptTarget({ id: "zzz" });
      assert.match(missing.error, /No running subagent with id "zzz"/);
      assert.match(missing.error, /Running subagents:/);
      assert.match(missing.error, /"Worker" \[id a1\]/);

      const missingByName = testApi.resolveInterruptTarget({ name: "Ghost" });
      assert.match(missingByName.error, /No running subagent named "Ghost"/);
      assert.match(missingByName.error, /Running subagents:/);
    } finally {
      runningMap.clear();
    }
  });
  it("returns an explicit error when Escape delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to send Escape/);
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        throw new Error("mux write failed");
      }));

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape without aborting or mutating running state", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    let sentSurface = "";
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, (surface: string) => {
      sentSurface = surface;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "a1");
      const activity = {
        version: 1,
        runningChildId: "a1",
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: 19_000,
        toolName: "bash",
      };
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

      try {
        runningMap.set("a1", makeRunning({
          activityFile,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        }));

        withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          sentSurface = surface;
        }));

        assert.equal(sentSurface, "pane-1");
        const state = runningMap.get("a1").statusState;
        const snapshot = classifyStatus(state, 20_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(state.lastActivityAtMs, 20_000);
        assert.equal(state.lastActivitySequence, 7);
        assert.equal(state.localOverrideSequence, 7);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        sentSurface = surface;
      }));

      assert.equal(sentSurface, "pane-1");
      assert.equal(result.content[0].text, 'Interrupt requested for subagent "Worker".');
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "interrupt_requested" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape again for repeated interrupt requests", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const surfaces: string[] = [];
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning());

      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });
      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });

      assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("rejects Claude-backed interrupt requests before delivery", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let delivered = false;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ cli: "claude" }));

      const result = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        delivered = true;
      });

      assert.equal(delivered, false);
      assert.match(result.content[0].text, /currently supported only for Pi-backed subagents/i);
      assert.deepEqual(result.details, {
        error: "claude interrupt unsupported",
        id: "a1",
        name: "Worker",
      });
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: pi --session/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_resume/);
    assert.match(presentation, /Resume: pi --session/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });

  it("registers subagent_cleanup in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredTools.some((tool) => tool.name === "subagent_cleanup"), true);
  });

  it("documents the worktree parameter in the subagent tool schema", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((t) => t.name === "subagent");
    assert.ok(tool, "subagent tool registered");
    const props = tool.parameters?.properties ?? {};
    assert.ok(props.worktree, "worktree parameter present in the tool schema");
    assert.match(props.worktree.description, /herdr only/);
    assert.match(props.worktree.description, /<repo-dir>-<name>/);
    assert.match(props.worktree.description, /overrides cwd/);
  });

    it("registers subagents_status in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((t) => t.name === "subagents_status");
    assert.ok(tool);
    assert.match(tool.description, /NOT the same as subagents_list/);
  });

  it("lists running subagents with ids and live status", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      const activeState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 5_000 }),
        { snapshot: "present", updatedAt: 100_000, sequence: 1, phase: "active", active: true, activeScope: "tool", activeSince: 100_000, activityLabel: "bash" },
        100_000,
      );
      runningMap.set("a1", makeRunning({
        id: "a1",
        name: "Worker",
        task: "fix the API tests",
        surface: "pane-a1",
        statusState: activeState,
      }));
      runningMap.set("z9", makeRunning({
        id: "z9",
        name: "Zombie",
        surface: "pane-z9",
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      }));

      runningMap.set("t1", makeRunning({
        id: "t1",
        name: "TabWorker",
        surface: "pane-t1",
        muxMode: "tab",
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      }));

      const result = withMockedNow(200_000, () =>
        testApi.handleSubagentsStatus({
          listAllSurfacesFn: () => ["pane-a1", "pane-z9", "pane-t1"],
          listNamedPanesFn: () => [],
          discoverOrphansFn: () => [],
        }),
      );

      assert.equal(result.details.count, 3);
      assert.equal(result.details.entries[0].id, "a1");
      assert.equal(result.details.entries[0].kind, "active");
      assert.equal(result.details.entries[0].activityLabel, "bash");
      assert.equal(result.details.entries[0].paneOpen, true);
      assert.equal(result.details.entries[1].id, "z9");
      assert.equal(result.details.entries[1].kind, "stalled");
      assert.equal(result.details.entries[1].paneOpen, true);
      assert.match(result.content[0].text, /Worker \[a1\]/);
      assert.match(result.content[0].text, /Zombie \[z9\]/);
      assert.match(result.content[0].text, /3 subagents \(3 tracked, 0 orphan\)/);
      assert.match(result.content[0].text, /TabWorker \[t1\] \[tab\]/);
      assert.equal(result.details.entries[2].mux, "tab");
      assert.match(result.content[0].text, /fix the API tests/);
    } finally {
      runningMap.clear();
    }
  });

  it("reports no running subagents when the registry is empty", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      const result = withMockedNow(200_000, () =>
        testApi.handleSubagentsStatus({
          listAllSurfacesFn: () => [],
          listNamedPanesFn: () => [],
          discoverOrphansFn: () => [],
        }),
      );
      assert.match(result.content[0].text, /No subagents or subagent panes found/);
      assert.equal(result.details.count, 0);
    } finally {
      runningMap.clear();
    }
  });

  it("reports orphan pi processes and orphan named panes alongside tracked entries", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-a1", statusState: createStatusState({ source: "pi", startTimeMs: 100_000 }) }));

      const result = withMockedNow(200_000, () =>
        testApi.handleSubagentsStatus({
          listAllSurfacesFn: () => ["pane-a1", "w4:pK"],
          listNamedPanesFn: () => [{ surface: "w4:pK", label: "Sumsub研究" }],
          discoverOrphansFn: (tracked) => [
            { pid: "4242", id: "deadbeef", name: "ghost-reviewer", surface: "pane-99" },
          ],
        }),
      );

      const text = result.content[0].text;
      assert.match(text, /\(1 tracked, 2 orphan\)/);
      assert.match(text, /ghost-reviewer \[orphan deadbeef\]/);
      assert.match(text, /pid 4242/);
      assert.match(text, /Sumsub研究 \[orphan pane w4:pK\]/);
      assert.equal(result.details.entries.length, 3);
      const orphanKinds = result.details.entries.map((e: any) => e.origin).sort();
      assert.deepEqual(orphanKinds, ["orphan-pane", "orphan-process", "registry"]);
    } finally {
      runningMap.clear();
    }
  });

  it("closes a specified surface directly, removing any matching running entry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const closedSurfaces: string[] = [];
    const aborted: string[] = [];
    runningMap.clear();

    try {
      runningMap.set("t1", makeRunning({
        id: "t1",
        name: "TabWorker",
        surface: "pane-t1",
        muxMode: "tab",
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        abortController: { abort: () => aborted.push("t1") },
      }));

      const tracked = testApi.handleSubagentCleanup(
        { surface: "pane-t1" },
        (surface: string) => closedSurfaces.push(surface),
      );
      assert.deepEqual(closedSurfaces, ["pane-t1"]);
      assert.deepEqual(aborted, ["t1"]);
      assert.equal(runningMap.has("t1"), false);
      assert.match(tracked.content[0].text, /Closed surface pane-t1/);
      assert.match(tracked.content[0].text, /TabWorker/);

      // Orphan surface with no running entry: still closes, no crash.
      const orphan = testApi.handleSubagentCleanup(
        { surface: "pane-orphan" },
        (surface: string) => closedSurfaces.push(surface),
      );
      assert.deepEqual(closedSurfaces, ["pane-t1", "pane-orphan"]);
      assert.match(orphan.content[0].text, /Closed surface pane-orphan/);
      assert.doesNotMatch(orphan.content[0].text, /running entry/);

      // Close failure is reported, not thrown.
      const failed = testApi.handleSubagentCleanup(
        { surface: "pane-gone" },
        () => {
          throw new Error("pane not found");
        },
      );
      assert.match(failed.content[0].text, /Failed to close surface "pane-gone"/);
      assert.match(failed.content[0].text, /pane not found/);
    } finally {
      runningMap.clear();
    }
  });

  it("shares the running registry with the auto-exit guard (same Map reference)", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // The guard reads globalThis.__piSubagentRunningRegistry; cleanup, the
      // watcher and spawn all mutate this very Map, so removals are visible
      // to hasRunningSubagents() immediately.
      assert.equal((globalThis as any).__piSubagentRunningRegistry, runningMap);

      runningMap.set("t1", makeRunning({ id: "t1", name: "TabWorker", surface: "pane-t1", muxMode: "tab" }));
      assert.equal((globalThis as any).__piSubagentRunningRegistry.size, 1);

      testApi.handleSubagentCleanup({ surface: "pane-t1" }, () => {});
      assert.equal((globalThis as any).__piSubagentRunningRegistry.size, 0);
      assert.equal(runningMap.size, 0);
    } finally {
      runningMap.clear();
    }
  });

  it("reaps a worktree workspace only after its last subagent finishes", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const closed: string[] = [];
    runningMap.clear();

    try {
      const wt = { workspaceId: "w9", rootPane: "w9:p1", reap: true };
      runningMap.set("a1", makeRunning({ id: "a1", surface: "w9:p2", worktree: wt }));
      runningMap.set("b2", makeRunning({ id: "b2", surface: "w9:p3", worktree: { ...wt } }));

      // Another subagent still lives in the workspace: keep it open.
      testApi.maybeReapWorktreeWorkspace(wt, (surface: string) => closed.push(surface));
      assert.deepEqual(closed, []);

      // Last one gone: the root pane is closed (herdr recycles the workspace).
      runningMap.delete("a1");
      runningMap.delete("b2");
      testApi.maybeReapWorktreeWorkspace(wt, (surface: string) => closed.push(surface));
      assert.deepEqual(closed, ["w9:p1"]);

      // User-opened workspaces are never reaped.
      closed.length = 0;
      testApi.maybeReapWorktreeWorkspace({ workspaceId: "w9", rootPane: "w9:p1", reap: false }, (s: string) => closed.push(s));
      assert.deepEqual(closed, []);

      // No worktree info at all: nothing to do.
      testApi.maybeReapWorktreeWorkspace(undefined, (s: string) => closed.push(s));
      assert.deepEqual(closed, []);
    } finally {
      runningMap.clear();
    }
  });

  it("cleans stalled entries but leaves active ones when no target is given", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const closedSurfaces: string[] = [];
    const aborted: string[] = [];
    runningMap.clear();

    try {
      // Stalled: created long ago with no activity snapshot ever observed.
      runningMap.set("s1", makeRunning({
        id: "s1",
        name: "Zombie1",
        surface: "pane-s1",
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        abortController: { abort: () => aborted.push("s1") },
      }));
      runningMap.set("s2", makeRunning({
        id: "s2",
        name: "Zombie2",
        surface: "pane-s2",
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        abortController: { abort: () => aborted.push("s2") },
      }));
      // Active: has a fresh present snapshot.
      const activeState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        { snapshot: "present", updatedAt: 100_000, sequence: 1, phase: "active", active: true, activeScope: "tool", activeSince: 100_000, activityLabel: "bash" },
        100_000,
      );
      runningMap.set("a1", makeRunning({
        id: "a1",
        name: "Worker",
        surface: "pane-a1",
        statusState: activeState,
        abortController: { abort: () => aborted.push("a1") },
      }));

      const result = withMockedNow(200_000, () =>
        testApi.handleSubagentCleanup({}, (surface: string) => closedSurfaces.push(surface)),
      );

      assert.deepEqual(closedSurfaces.sort(), ["pane-s1", "pane-s2"]);
      assert.deepEqual(aborted.sort(), ["s1", "s2"]);
      assert.equal(runningMap.has("s1"), false);
      assert.equal(runningMap.has("s2"), false);
      assert.equal(runningMap.has("a1"), true);
      assert.equal(result.details.count, 2);
      assert.match(result.content[0].text, /Cleaned up 2 stalled subagents/);
    } finally {
      runningMap.clear();
    }
  });

  it("force-cleans a specified target regardless of status", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const closedSurfaces: string[] = [];
    runningMap.clear();

    try {
      const activeState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        { snapshot: "present", updatedAt: 100_000, sequence: 1, phase: "active", active: true, activeScope: "tool", activeSince: 100_000, activityLabel: "bash" },
        100_000,
      );
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "pane-a1", statusState: activeState }));

      const result = withMockedNow(200_000, () =>
        testApi.handleSubagentCleanup({ id: "a1" }, (surface: string) => closedSurfaces.push(surface)),
      );

      assert.deepEqual(closedSurfaces, ["pane-a1"]);
      assert.equal(runningMap.has("a1"), false);
      assert.equal(result.details.status, "cleaned");
      assert.match(result.content[0].text, /forced subagent/);
    } finally {
      runningMap.clear();
    }
  });

  it("reports when there is nothing stalled to clean", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const closedSurfaces: string[] = [];
    runningMap.clear();

    try {
      const result = withMockedNow(200_000, () =>
        testApi.handleSubagentCleanup({}, (surface: string) => closedSurfaces.push(surface)),
      );
      assert.match(result.content[0].text, /No stalled subagents to clean up/);
      assert.equal(closedSurfaces.length, 0);

      const missing = withMockedNow(200_000, () =>
        testApi.handleSubagentCleanup({ id: "zzz" }, (surface: string) => closedSurfaces.push(surface)),
      );
      assert.match(missing.content[0].text, /No running subagent/);
    } finally {
      runningMap.clear();
    }
  });
});

describe("steering messages", () => {
  describe("steer.ts inbox", () => {
    it("builds a per-child inbox path under the artifact dir", () => {
      const steerFile = getSubagentSteerFile("/tmp/artifacts/sess-1", "abc123");
      assert.equal(steerFile, "/tmp/artifacts/sess-1/subagent-steer/abc123.jsonl");
    });

    it("round-trips messages in order and preserves arbitrary text", () => {
      withTempDir((dir) => {
        const steerFile = getSubagentSteerFile(dir, "child-1");
        appendSteerMessage(steerFile, "Focus on the API design first");
        appendSteerMessage(steerFile, "Line one\nLine two with /special chars \"quoted\" and 中文");

        const drained = drainSteerMessages(steerFile);
        assert.equal(drained.length, 2);
        assert.equal(drained[0].message, "Focus on the API design first");
        assert.equal(
          drained[1].message,
          "Line one\nLine two with /special chars \"quoted\" and 中文",
        );
        assert.equal(drained[0].from, "parent");
        assert.ok(drained[0].sentAt.length > 0);

        // Inbox is empty after draining
        assert.deepEqual(drainSteerMessages(steerFile), []);
      });
    });

    it("skips malformed lines without wedging the inbox", () => {
      withTempDir((dir) => {
        const steerFile = getSubagentSteerFile(dir, "child-2");
        mkdirSync(dirname(steerFile), { recursive: true });
        writeFileSync(steerFile, "not-json\n{\"message\": 42}\n{\"message\": \"ok\"}\n", "utf8");

        const drained = drainSteerMessages(steerFile);
        assert.equal(drained.length, 1);
        assert.equal(drained[0].message, "ok");
      });
    });

    it("picks up messages appended after a previous drain", () => {
      withTempDir((dir) => {
        const steerFile = getSubagentSteerFile(dir, "child-3");
        appendSteerMessage(steerFile, "first");
        assert.equal(drainSteerMessages(steerFile).length, 1);
        assert.equal(drainSteerMessages(steerFile).length, 0);
        appendSteerMessage(steerFile, "second");
        const drained = drainSteerMessages(steerFile);
        assert.equal(drained.length, 1);
        assert.equal(drained[0].message, "second");
      });
    });
  });

  describe("steer poller", () => {
    it("delivers one message per poll with steer delivery and requeues the rest", () => {
      withTempDir((dir) => {
        const steerFile = getSubagentSteerFile(dir, "child-1");
        appendSteerMessage(steerFile, "msg-a");
        appendSteerMessage(steerFile, "msg-b");
        appendSteerMessage(steerFile, "msg-c");

        const delivered: Array<{ message: string; options?: unknown }> = [];
        const poller = createSteerPoller({
          steerFile,
          sendUserMessage(message, options) {
            delivered.push({ message, options });
          },
        });

        assert.equal(poller.poll(), 3); // drained all three…
        assert.equal(delivered.length, 1); // …but delivered only the first
        assert.equal(delivered[0].message, "msg-a");
        assert.deepEqual(delivered[0].options, { deliverAs: "steer" });

        assert.equal(poller.poll(), 2); // drained [b, c]…
        assert.equal(delivered.length, 2); // …delivered only b, requeued c
        assert.equal(delivered[1].message, "msg-b");
        assert.equal(poller.poll(), 1);
        assert.equal(delivered.length, 3);
        assert.equal(delivered[2].message, "msg-c");
        assert.equal(poller.poll(), 0);
      });
    });
  });

  describe("subagent_steer tool", () => {
    function makeRunning(overrides: Record<string, unknown> = {}) {
      return {
        id: "a1",
        name: "Worker",
        task: "",
        surface: "pane-1",
        startTime: 0,
        sessionFile: "worker.jsonl",
        steerFile: "/tmp/worker.steer.jsonl",
        interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        ...overrides,
      };
    }

    it("registers subagent_steer in the main session extension", () => {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const steerTool = registeredTools.find((tool) => tool.name === "subagent_steer");
      assert.ok(steerTool, "expected subagent_steer tool to be registered");
      assert.equal(steerTool.parameters.required.includes("message"), true);
      const messageSchema = steerTool.parameters.properties.message;
      assert.equal(messageSchema.type, "string");
    });

    it("queues a steering message into the running subagent's inbox", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();
      try {
        const appended: Array<{ file: string; message: string }> = [];
        runningMap.set("a1", makeRunning({ id: "a1" }));
        const result = testApi.handleSubagentSteer(
          { name: "Worker", message: "Please switch to plan B" },
          (file: string, message: string) => {
            appended.push({ file, message });
          },
        );

        assert.equal(result.details.status, "steered");
        assert.equal(result.details.name, "Worker");
        assert.equal(result.details.message, "Please switch to plan B");
        assert.equal(appended.length, 1);
        assert.equal(appended[0].file, "/tmp/worker.steer.jsonl");
        assert.equal(appended[0].message, "Please switch to plan B");
      } finally {
        runningMap.clear();
      }
    });

    it("resolves by exact id and rejects ambiguous names", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();
      try {
        runningMap.set("a1", makeRunning({ id: "a1", name: "Worker" }));
        runningMap.set("b2", makeRunning({ id: "b2", name: "Worker" }));
        runningMap.set("c3", makeRunning({ id: "c3", name: "Scout" }));

        const byId = testApi.handleSubagentSteer(
          { id: "c3", message: "steer c3" },
          () => {},
        );
        assert.equal(byId.details.id, "c3");
        assert.equal(byId.details.status, "steered");

        const ambiguous = testApi.handleSubagentSteer(
          { name: "Worker", message: "steer ambiguous" },
          () => {},
        );
        assert.match(ambiguous.content[0].text, /Ambiguous subagent name/);

        const missing = testApi.handleSubagentSteer(
          { name: "Ghost", message: "hi" },
          () => {},
        );
        assert.match(missing.content[0].text, /No running subagent named/);
      } finally {
        runningMap.clear();
      }
    });

    it("rejects missing messages, Claude-backed children, and missing inboxes", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();
      try {
        const noMessage = testApi.handleSubagentSteer({ name: "Worker" });
        assert.match(noMessage.content[0].text, /Provide a steering message/);

        runningMap.set("c9", makeRunning({ id: "c9", name: "ClaudeKid", cli: "claude" }));
        const claude = testApi.handleSubagentSteer(
          { name: "ClaudeKid", message: "hi" },
          () => {
            throw new Error("should not be called");
          },
        );
        assert.match(claude.content[0].text, /only for Pi-backed subagents/);

        runningMap.set("d4", makeRunning({ id: "d4", name: "NoInbox" }));
        const runningNoInbox = runningMap.get("d4");
        delete runningNoInbox.steerFile;
        const noInbox = testApi.handleSubagentSteer(
          { name: "NoInbox", message: "hi" },
          () => {
            throw new Error("should not be called");
          },
        );
        assert.match(noInbox.content[0].text, /no steer inbox/);
      } finally {
        runningMap.clear();
      }
    });

    it("reports write failures instead of claiming success", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();
      try {
        runningMap.set("a1", makeRunning({ id: "a1" }));
        const result = testApi.handleSubagentSteer(
          { name: "Worker", message: "hi" },
          () => {
            throw new Error("disk full");
          },
        );
        assert.match(result.content[0].text, /Failed to queue steering message/);
        assert.match(result.details.error, /steer write failed/);
      } finally {
        runningMap.clear();
      }
    });
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("parseCmuxFocusedSnapshot", () => {
    it("parses focused surface and pane refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshot({ focused: { surface_ref: "surface:3", pane_ref: "pane:2" } }),
        { surfaceRef: "surface:3", paneRef: "pane:2" },
      );
    });

    it("does not fall back to caller refs", () => {
      assert.equal(
        parseCmuxFocusedSnapshot({ caller: { surface_ref: "surface:1", pane_ref: "pane:1" } }),
        null,
      );
    });

    it("returns null for malformed values", () => {
      assert.equal(parseCmuxFocusedSnapshot(null), null);
      assert.equal(parseCmuxFocusedSnapshot({ focused: {} }), null);
    });
  });

  describe("parseCmuxJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxJson("not json"), null);
    });

    it("parses valid JSON text", () => {
      assert.deepEqual(parseCmuxJson('{"ok":true}'), { ok: true });
    });
  });

  describe("parseCmuxFocusedSnapshotFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxFocusedSnapshotFromJson("not json"), null);
    });

    it("returns null when focused is absent or not an object", () => {
      assert.equal(
        parseCmuxFocusedSnapshotFromJson('{"focused":null,"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}'),
        null,
      );
      assert.equal(
        parseCmuxFocusedSnapshotFromJson('{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}'),
        null,
      );
    });

    it("parses focused refs without falling back to caller refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshotFromJson(
          '{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"},"focused":{"surface_ref":"surface:2","pane_ref":"pane:3"}}',
        ),
        { surfaceRef: "surface:2", paneRef: "pane:3" },
      );
    });
  });

  describe("parseCmuxPaneRefForSurface", () => {
    it("parses top-level pane refs for a surface", () => {
      assert.equal(
        parseCmuxPaneRefForSurface({ surface_ref: "surface:7", pane_ref: "pane:4" }, "surface:7"),
        "pane:4",
      );
    });

    it("parses caller pane refs for identify --surface output", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { caller: { surface_ref: "surface:7", pane_ref: "pane:4" } },
          "surface:7",
        ),
        "pane:4",
      );
    });

    it("returns null when the surface does not match", () => {
      assert.equal(
        parseCmuxPaneRefForSurface({ surface_ref: "surface:8", pane_ref: "pane:4" }, "surface:7"),
        null,
      );
    });
  });

  describe("parseCmuxPaneRefForSurfaceFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxPaneRefForSurfaceFromJson("not json", "surface:7"), null);
    });

    it("parses caller refs from cmux identify --surface JSON text", () => {
      assert.equal(
        parseCmuxPaneRefForSurfaceFromJson(
          '{"caller":{"surface_ref":"surface:7","pane_ref":"pane:4"}}',
          "surface:7",
        ),
        "pane:4",
      );
    });
  });

  describe("zellij placement", () => {
    const pane = (overrides: any) => ({
      id: 1,
      is_plugin: false,
      is_floating: false,
      is_selectable: true,
      exited: false,
      pane_rows: 20,
      pane_columns: 80,
      tab_id: 1,
      ...overrides,
    });

    it("matches Zellij direction and minimum split rules", () => {
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 11 })), "right");
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 11, pane_columns: 5 })), "down");
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 10 })), null);
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 4, pane_columns: 80 })), null);

      assert.equal(canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 11 })), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 11, pane_columns: 5 })), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 10 })), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 4, pane_columns: 80 })), false);

      assert.equal(canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 100 }), 80, 20), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 45, pane_columns: 100 }), 80, 20), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 170 }), 80, 20), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 47 }), 50, 10), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 77 }), 50, 10), true);
    });

    it("uses tab-scoped split only when all Zellij split candidates are safe", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 40, pane_columns: 120 }),
          pane({ id: 11, tab_id: 1, pane_rows: 120, pane_columns: 100 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "split",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
        splitDirection: "down",
      });
    });

    it("stacks when any Zellij split candidate would fall below Pi's configured minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 100, pane_columns: 47 }),
          pane({ id: 11, tab_id: 1, pane_rows: 31, pane_columns: 77 }),
        ],
        10,
        50,
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("stacks when Zellij would split a pane below Pi's usable minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 20, pane_columns: 20 }),
          pane({ id: 11, tab_id: 1, pane_rows: 18, pane_columns: 60 }),
          pane({ id: 12, tab_id: 1, pane_rows: 10, pane_columns: 70 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("never chooses the parent pane as the stack target", () => {
      const plan = selectZellijStackPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 }),
          pane({ id: 11, tab_id: 1, pane_rows: 10, pane_columns: 20 }),
          pane({ id: 12, tab_id: 1, pane_rows: 8, pane_columns: 30 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 12,
        targetPaneId: 12,
        tabId: 1,
      });
    });

    it("does not stack when the only usable pane is the parent", () => {
      const plan = selectZellijStackPlacement(
        [pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 })],
        10,
      );

      assert.equal(plan, null);
    });

    it("stacks on the largest usable non-parent pane when none can split", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({ id: 11, tab_id: 1, pane_rows: 6, pane_columns: 8 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("ignores floating, plugin, exited, unselectable, and other-tab panes", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({ id: 11, tab_id: 1, pane_rows: 60, pane_columns: 200, is_floating: true }),
          pane({ id: 12, tab_id: 1, pane_rows: 60, pane_columns: 200, is_plugin: true }),
          pane({ id: 13, tab_id: 1, pane_rows: 60, pane_columns: 200, exited: true }),
          pane({ id: 14, tab_id: 1, pane_rows: 60, pane_columns: 200, is_selectable: false }),
          pane({ id: 15, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.equal(plan, null);
    });

    it("returns null when the parent pane cannot be found", () => {
      assert.equal(selectZellijPlacement([pane({ id: 10 })], 99), null);
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isWezTermAvailable", () => {
    it("returns boolean based on WEZTERM_UNIX_SOCKET", () => {
      const result = isWezTermAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isHerdrAvailable", () => {
    it("returns boolean based on HERDR_ENV and herdr binary", () => {
      const result = isHerdrAvailable();
      assert.equal(typeof result, "boolean");
    });
  });
});

describe("resolveParentModel", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-model-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(lines: string[]): string {
    const file = join(dir, `session-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(file, lines.map((l) => l.trim()).filter(Boolean).join("\n") + "\n", "utf8");
    return file;
  }

  it("returns the LAST model_change (provider + modelId)", () => {
    const file = writeSession([
      JSON.stringify({ type: "session", version: 3, id: "s1" }),
      JSON.stringify({ type: "model_change", id: "m1", provider: "anthropic", modelId: "claude-sonnet-4-5" }),
      JSON.stringify({ type: "model_change", id: "m2", provider: "cpa_mybitx", modelId: "mybitx/gpt-5.6-sol" }),
    ]);
    assert.deepEqual(subagentsModule.__test__.resolveParentModel(file), {
      provider: "cpa_mybitx",
      modelId: "mybitx/gpt-5.6-sol",
    });
  });

  it("returns null when the session has no model_change", () => {
    const file = writeSession([
      JSON.stringify({ type: "session", version: 3, id: "s1" }),
      JSON.stringify({ type: "thinking_level_change", id: "t1", thinkingLevel: "xhigh" }),
    ]);
    assert.equal(subagentsModule.__test__.resolveParentModel(file), null);
  });

  it("returns null for a missing/unreadable file", () => {
    assert.equal(subagentsModule.__test__.resolveParentModel(join(dir, "does-not-exist.jsonl")), null);
  });

  it("ignores malformed lines but keeps a later valid model_change", () => {
    const file = writeSession([
      JSON.stringify({ type: "model_change", id: "m1", provider: "google", modelId: "gemini-pro" }),
      "{not valid json",
      JSON.stringify({ type: "model_change", id: "m2", provider: "cpa_arb", modelId: "arb/gpt-x" }),
    ]);
    assert.deepEqual(subagentsModule.__test__.resolveParentModel(file), {
      provider: "cpa_arb",
      modelId: "arb/gpt-x",
    });
  });
});

describe("poll abort controller lifecycle", () => {
  const KEY = Symbol.for("pi-subagents/poll-abort-controller");

  it("getModuleAbortSignal self-heals when the shared controller was aborted (session_shutdown poison)", () => {
    // Simulate the historical bug: something aborted the process-wide
    // controller and nothing rotated it. A watcher signal must never be
    // already-aborted at spawn time.
    const poisoned = new AbortController();
    poisoned.abort();
    (globalThis as any)[KEY] = poisoned;

    const signal = subagentsModule.__test__.getModuleAbortSignal();
    assert.equal(signal.aborted, false);

    // And the stored controller is a fresh one, not the poisoned instance.
    const stored = (globalThis as any)[KEY] as AbortController;
    assert.notEqual(stored, poisoned);
    assert.equal(stored.signal.aborted, false);
  });

  it("rotateModuleAbortController aborts the previous generation and installs a live controller", () => {
    const first = new AbortController();
    (globalThis as any)[KEY] = first;
    subagentsModule.__test__.rotateModuleAbortController();

    const stored = (globalThis as any)[KEY] as AbortController;
    assert.notEqual(stored, first);
    assert.equal(first.signal.aborted, true);
    assert.equal(stored.signal.aborted, false);

    // A signal captured before the rotation is cancelled; a fresh read is not.
    assert.equal(first.signal.aborted, true);
    assert.equal(subagentsModule.__test__.getModuleAbortSignal().aborted, false);
  });

  it("rotateModuleAbortController is idempotent on an already-aborted controller", () => {
    const poisoned = new AbortController();
    poisoned.abort();
    (globalThis as any)[KEY] = poisoned;
    subagentsModule.__test__.rotateModuleAbortController();
    assert.equal(((globalThis as any)[KEY] as AbortController).signal.aborted, false);
  });
});
