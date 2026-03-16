import { describe, expect, it } from "vitest";
import { evaluateGuardedWriteAccess, resolveDefaultGuardMode } from "./guard-mode.js";

describe("resolveDefaultGuardMode", () => {
  it("defaults webclaw-like sessions to watch", () => {
    expect(
      resolveDefaultGuardMode({
        sessionKey: "agent:main:webchat:abc",
      }),
    ).toBe("watch");
  });

  it("defaults non-control sessions to assist", () => {
    expect(
      resolveDefaultGuardMode({
        sessionKey: "agent:main:main",
      }),
    ).toBe("assist");
  });
});

describe("evaluateGuardedWriteAccess", () => {
  const workspaceDir = "/tmp/workspace";

  it("blocks writes in watch mode", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "write",
      toolParams: { path: "/tmp/workspace/STANDUP.md" },
      workspaceDir,
      entry: { guardMode: "watch" },
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("expected blocked result");
    }
    expect(result.reason).toContain("watch mode");
  });

  it("allows assist writes under workspace memory", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "write",
      toolParams: { path: "/tmp/workspace/memory/2026-03-13.md" },
      workspaceDir,
      entry: { guardMode: "assist" },
    });
    expect(result).toEqual({ allowed: true, mode: "assist" });
  });

  it("allows assist writes to top-level markdown", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "edit",
      toolParams: { path: "/tmp/workspace/STANDUP.md" },
      workspaceDir,
      entry: { guardMode: "assist" },
    });
    expect(result).toEqual({ allowed: true, mode: "assist" });
  });

  it("blocks assist writes to code paths", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "edit",
      toolParams: { path: "/home/scott/dev/openclaw/src/agents/pi-tools.ts" },
      workspaceDir,
      entry: { guardMode: "assist" },
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("expected blocked result");
    }
    expect(result.reason).toContain("source-code");
  });

  it("blocks apply_patch outside implement mode", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "apply_patch",
      toolParams: {
        patch: "*** Begin Patch\n*** Update File: /tmp/workspace/STANDUP.md\n*** End Patch\n",
      },
      workspaceDir,
      entry: { guardMode: "assist" },
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("expected blocked result");
    }
    expect(result.reason).toContain("apply_patch");
  });

  it("allows implement mode writes", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "edit",
      toolParams: { path: "/home/scott/dev/openclaw/src/agents/pi-tools.ts" },
      workspaceDir,
      entry: {
        guardMode: "implement",
        guardTask: "update pi-tools.ts fence handling",
      },
    });
    expect(result).toEqual({ allowed: true, mode: "implement" });
  });

  it("blocks implement-mode source writes when guardTask is missing", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "edit",
      toolParams: { path: "/home/scott/dev/openclaw/src/agents/pi-tools.ts" },
      workspaceDir,
      entry: { guardMode: "implement" },
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("expected blocked result");
    }
    expect(result.reason).toContain("guardTask");
  });

  it("allows implement-mode source writes when guardTask is present", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "edit",
      toolParams: { path: "/home/scott/dev/openclaw/src/agents/pi-tools.ts" },
      workspaceDir,
      entry: {
        guardMode: "implement",
        guardTask: "fix latency display in operator-overview.ts",
      },
    });
    expect(result).toEqual({ allowed: true, mode: "implement" });
  });

  it("allows implement-mode source writes within explicit task scope", () => {
    const result = evaluateGuardedWriteAccess({
      toolName: "apply_patch",
      toolParams: {
        patch:
          "*** Begin Patch\n*** Update File: /home/scott/dev/openclaw/src/ui/operator-overview.ts\n*** End Patch\n",
      },
      workspaceDir,
      entry: {
        guardMode: "implement",
        guardTask: "fix latency display in src/ui/operator-overview.ts",
      },
    });
    expect(result).toEqual({ allowed: true, mode: "implement" });
  });
});
