import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/cli/config.js";
import {
  chatAgentName,
  chatSessionsDir,
  lastChatActivityMs,
  waitForChatQuiescence,
} from "../src/scheduler/quiescence.js";

let agentRoot = "";
let sessionsDir = "";
let cfg: Config;
let prevChatAgent: string | undefined;

function makeCfg(mode: "test" | "prod"): Config {
  return {
    dbPath: ":memory:",
    port: 0,
    dailyUsdBudget: 0,
    openclawPath: null,
    logsDir: path.join(agentRoot, "logs"),
    agentIdentity: "trellis-test",
    openclawMode: mode,
    agentWorkspaceDir: path.join(agentRoot, "workspace"),
    agentStateDir: path.join(agentRoot, "state"),
    sessionsArchiveDir: path.join(agentRoot, "sessions"),
  };
}

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-quiescence-test-"));
  sessionsDir = path.join(agentRoot, "state", "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  cfg = makeCfg("prod");
  prevChatAgent = process.env.TRELLIS_CHAT_AGENT;
});

afterEach(() => {
  if (prevChatAgent === undefined) delete process.env.TRELLIS_CHAT_AGENT;
  else process.env.TRELLIS_CHAT_AGENT = prevChatAgent;
  if (agentRoot) fs.rmSync(agentRoot, { recursive: true, force: true });
});

function writeSession(name: string, mtimeMs: number): void {
  const p = path.join(sessionsDir, name);
  fs.writeFileSync(p, "{}\n");
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

describe("chat agent name resolution", () => {
  it('defaults to "main"', () => {
    delete process.env.TRELLIS_CHAT_AGENT;
    expect(chatAgentName()).toBe("main");
  });
  it("respects TRELLIS_CHAT_AGENT override", () => {
    process.env.TRELLIS_CHAT_AGENT = "cass-2";
    expect(chatAgentName()).toBe("cass-2");
  });
  it('returns null for empty string ("disable chat watch")', () => {
    process.env.TRELLIS_CHAT_AGENT = "";
    expect(chatAgentName()).toBeNull();
  });
});

describe("chatSessionsDir", () => {
  it("returns null in test mode", () => {
    expect(chatSessionsDir(makeCfg("test"))).toBeNull();
  });
  it("returns null when chat agent disabled", () => {
    process.env.TRELLIS_CHAT_AGENT = "";
    expect(chatSessionsDir(cfg)).toBeNull();
  });
  it("composes <state>/agents/<agent>/sessions in prod", () => {
    expect(chatSessionsDir(cfg)).toBe(sessionsDir);
  });
});

describe("lastChatActivityMs", () => {
  it("returns null for an empty dir", () => {
    expect(lastChatActivityMs(cfg)).toBeNull();
  });
  it("returns null for a missing dir", () => {
    fs.rmSync(sessionsDir, { recursive: true });
    expect(lastChatActivityMs(cfg)).toBeNull();
  });
  it("ignores trellis-prefixed sessions", () => {
    const t = Date.now();
    writeSession("trellis-trellis-default.jsonl", t);
    expect(lastChatActivityMs(cfg)).toBeNull();
  });
  it("ignores sessions.json index", () => {
    const t = Date.now();
    writeSession("sessions.json", t);
    expect(lastChatActivityMs(cfg)).toBeNull();
  });
  it("returns max mtime across qualifying files", () => {
    writeSession("a.jsonl", 1000);
    writeSession("b.jsonl", 5000);
    writeSession("trellis-x.jsonl", 9000); // ignored
    expect(lastChatActivityMs(cfg)).toBe(5000);
  });
});

describe("waitForChatQuiescence", () => {
  it("returns immediately in test mode", async () => {
    const r = await waitForChatQuiescence(makeCfg("test"));
    expect(r.waited).toBe(false);
    expect(r.reason).toMatch(/no chat agent/);
  });

  it("returns immediately when no chat sessions exist", async () => {
    const r = await waitForChatQuiescence(cfg);
    expect(r.waited).toBe(false);
    expect(r.reason).toMatch(/no chat sessions/);
  });

  it("returns immediately when chat is already idle past the window", async () => {
    const now = Date.now();
    writeSession("a.jsonl", now - 10 * 60 * 1000);
    const r = await waitForChatQuiescence(cfg, { windowMs: 5 * 60 * 1000 });
    expect(r.waited).toBe(false);
    expect(r.reason).toMatch(/idle/);
  });

  it("waits when chat is recent, returns when window passes", async () => {
    const baseT = 1_000_000_000_000;
    writeSession("a.jsonl", baseT - 60_000); // 60s ago
    let nowT = baseT;
    const sleeps: number[] = [];
    const r = await waitForChatQuiescence(cfg, {
      windowMs: 120_000, // need 120s idle
      maxWaitMs: 600_000,
      pollMs: 30_000,
      now: () => nowT,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowT += ms;
      },
    });
    expect(r.waited).toBe(true);
    // file is 60s old at start; need 120s old; so we sleep ~60s+ once.
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(r.reason).toMatch(/idle/);
  });

  it("gives up after maxWaitMs if chat keeps being touched", async () => {
    const baseT = 1_000_000_000_000;
    writeSession("a.jsonl", baseT); // current
    let nowT = baseT;
    const r = await waitForChatQuiescence(cfg, {
      windowMs: 60_000,
      maxWaitMs: 100_000,
      pollMs: 30_000,
      now: () => nowT,
      sleep: async (ms) => {
        nowT += ms;
        // Simulate continuous chat by re-touching the file.
        writeSession("a.jsonl", nowT);
      },
    });
    expect(r.waited).toBe(true);
    expect(r.reason).toMatch(/gave up/);
  });
});
