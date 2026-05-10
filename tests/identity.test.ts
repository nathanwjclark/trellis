import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/cli/config.js";
import { ensureAgentIdentity } from "../src/openclaw/identity.js";

let agentRoot = "";
let cfg: Config;

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-identity-test-"));
  cfg = {
    dbPath: ":memory:",
    port: 0,
    dailyUsdBudget: 0,
    openclawPath: null,
    logsDir: path.join(agentRoot, "logs"),
    agentIdentity: "trellis-test",
    openclawMode: "test",
    agentWorkspaceDir: path.join(agentRoot, "workspace"),
    agentStateDir: path.join(agentRoot, "state"),
    sessionsArchiveDir: path.join(agentRoot, "sessions"),
  };
});

afterEach(() => {
  if (agentRoot) fs.rmSync(agentRoot, { recursive: true, force: true });
});

describe("ensureAgentIdentity (test mode)", () => {
  it("creates workspace, state, and sessions dirs", () => {
    ensureAgentIdentity(cfg);
    expect(fs.existsSync(cfg.agentWorkspaceDir)).toBe(true);
    expect(fs.existsSync(cfg.agentStateDir)).toBe(true);
    expect(fs.existsSync(cfg.sessionsArchiveDir)).toBe(true);
  });

  it("writes openclaw.json with skipBootstrap=true and workspace path", () => {
    const { configPath } = ensureAgentIdentity(cfg);
    const json = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(json["agents.defaults.skipBootstrap"]).toBe(true);
    expect(json["agents.defaults.workspace"]).toBe(cfg.agentWorkspaceDir);
  });

  it("enables memory + skill plugins in openclaw.json", () => {
    const { configPath } = ensureAgentIdentity(cfg);
    const json = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(json["plugins.enabled"]).toBe(true);
    expect(json["plugins.entries.active-memory.enabled"]).toBe(true);
    expect(json["plugins.entries.memory-wiki.enabled"]).toBe(true);
    expect(json["plugins.entries.skill-workshop.enabled"]).toBe(true);
  });

  it("SOUL.md frames the agent generally, not as a Trellis-only worker", () => {
    ensureAgentIdentity(cfg);
    const soul = fs.readFileSync(
      path.join(cfg.agentWorkspaceDir, "SOUL.md"),
      "utf8",
    );
    // Should describe the agent generally; Trellis is mentioned as one of
    // many contexts, not as the agent's whole identity.
    expect(soul).toMatch(/curious|capable|opinionated/i);
    // Trellis mentioned as one of many contexts, not as identity-defining.
    expect(soul).toMatch(/Trellis\*?\*? is one/i);
    expect(soul).not.toMatch(/^I am a Trellis worker/m);
  });

  it("pre-fills SOUL.md, IDENTITY.md, AGENTS.md when missing", () => {
    const { refreshed } = ensureAgentIdentity(cfg);
    expect(refreshed.soulMd).toBe(true);
    expect(refreshed.identityMd).toBe(true);
    expect(refreshed.agentsMd).toBe(true);
    expect(
      fs.readFileSync(path.join(cfg.agentWorkspaceDir, "SOUL.md"), "utf8"),
    ).toMatch(/Trellis/);
    expect(
      fs.readFileSync(path.join(cfg.agentWorkspaceDir, "AGENTS.md"), "utf8"),
    ).toMatch(/sandbox boundary|Sandbox boundary/i);
  });

  it("does not overwrite existing identity files", () => {
    fs.mkdirSync(cfg.agentWorkspaceDir, { recursive: true });
    const customSoul = "# Custom soul\n\nI am the user's pre-existing agent.\n";
    fs.writeFileSync(
      path.join(cfg.agentWorkspaceDir, "SOUL.md"),
      customSoul,
    );
    const { refreshed } = ensureAgentIdentity(cfg);
    expect(refreshed.soulMd).toBe(false);
    expect(
      fs.readFileSync(path.join(cfg.agentWorkspaceDir, "SOUL.md"), "utf8"),
    ).toBe(customSoul);
  });

  it("re-rewrites openclaw.json on every call (config drift correction)", () => {
    const { configPath } = ensureAgentIdentity(cfg);
    fs.writeFileSync(configPath, "{}");
    ensureAgentIdentity(cfg);
    const json = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(json["agents.defaults.skipBootstrap"]).toBe(true);
  });
});

describe("ensureAgentIdentity (prod mode)", () => {
  beforeEach(() => {
    cfg = { ...cfg, openclawMode: "prod" };
  });

  it("does NOT write openclaw.json (user owns config)", () => {
    fs.mkdirSync(cfg.agentWorkspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfg.agentWorkspaceDir, "SOUL.md"),
      "# Real onboarded agent\n",
    );
    const { configPath } = ensureAgentIdentity(cfg);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("respects TRELLIS_AGENT_WORKSPACE / TRELLIS_AGENT_STATE_DIR overrides", () => {
    // Put workspace + state in different locations to verify they're
    // independently overridable.
    cfg = {
      ...cfg,
      agentWorkspaceDir: path.join(agentRoot, "elsewhere", "ws"),
      agentStateDir: path.join(agentRoot, "elsewhere", "state"),
    };
    fs.mkdirSync(cfg.agentWorkspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfg.agentWorkspaceDir, "SOUL.md"),
      "# pre-existing\n",
    );
    ensureAgentIdentity(cfg);
    expect(fs.existsSync(cfg.agentWorkspaceDir)).toBe(true);
    expect(fs.existsSync(cfg.agentStateDir)).toBe(true);
  });

  it("does NOT pre-fill identity files", () => {
    fs.mkdirSync(cfg.agentWorkspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfg.agentWorkspaceDir, "SOUL.md"),
      "# pre-existing\n",
    );
    const { refreshed } = ensureAgentIdentity(cfg);
    expect(refreshed.soulMd).toBe(false);
    expect(
      fs.existsSync(path.join(cfg.agentWorkspaceDir, "IDENTITY.md")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(cfg.agentWorkspaceDir, "AGENTS.md")),
    ).toBe(false);
  });

  it("errors loudly if SOUL.md is missing", () => {
    expect(() => ensureAgentIdentity(cfg)).toThrow(/prod mode/);
  });
});
