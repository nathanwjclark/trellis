import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgentMemory } from "../src/cycle/memory.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-memtest-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readAgentMemory", () => {
  it("returns empty bundle when nothing exists", () => {
    const r = readAgentMemory(dir);
    expect(r.text).toBe("");
    expect(r.files).toEqual([]);
    expect(r.missing).toEqual(["IDENTITY.md", "SOUL.md", "MEMORY.md"]);
  });

  it("concatenates IDENTITY/SOUL/MEMORY in order", () => {
    fs.writeFileSync(path.join(dir, "IDENTITY.md"), "# id\nname: Cass");
    fs.writeFileSync(path.join(dir, "SOUL.md"), "# soul\ngraceful");
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# memory\nstuff");
    const r = readAgentMemory(dir);
    expect(r.text).toContain("name: Cass");
    expect(r.text).toContain("graceful");
    expect(r.text).toContain("stuff");
    expect(r.files.map((f) => f.path)).toEqual([
      "IDENTITY.md",
      "SOUL.md",
      "MEMORY.md",
    ]);
    // Order: IDENTITY before SOUL before MEMORY in the concatenated text.
    const a = r.text.indexOf("name: Cass");
    const b = r.text.indexOf("graceful");
    const c = r.text.indexOf("stuff");
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("includes recent daily journal entries (most recent N)", () => {
    fs.mkdirSync(path.join(dir, "memory"));
    for (const d of [
      "2026-04-01.md",
      "2026-04-15.md",
      "2026-05-01.md",
      "2026-05-09.md",
      "2026-05-10.md",
    ]) {
      fs.writeFileSync(path.join(dir, "memory", d), `entry for ${d}`);
    }
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "x");
    const r = readAgentMemory(dir);
    // All 5 included (cap is 7).
    for (const d of [
      "2026-04-01.md",
      "2026-04-15.md",
      "2026-05-01.md",
      "2026-05-09.md",
      "2026-05-10.md",
    ]) {
      expect(r.text).toContain(`entry for ${d}`);
    }
  });

  it("truncates oversized files and notes the truncation", () => {
    const huge = "X".repeat(200_000);
    fs.writeFileSync(path.join(dir, "MEMORY.md"), huge);
    const r = readAgentMemory(dir);
    expect(r.files.find((f) => f.path === "MEMORY.md")?.truncated).toBe(true);
    expect(r.text).toMatch(/truncated/);
  });
});
