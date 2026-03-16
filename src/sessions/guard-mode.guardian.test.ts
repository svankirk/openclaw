import { completeSimple } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { runImplementGuardScopeCheck } from "./guard-mode.guardian.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn((provider: string, modelId: string) => ({
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "openai-completions",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 8192,
    },
    authStorage: {},
    modelRegistry: {},
  })),
}));

const mockCompleteSimple = vi.mocked(completeSimple);
const mockGetApiKeyForModel = vi.mocked(getApiKeyForModel);
const mockResolveModel = vi.mocked(resolveModel);

describe("runImplementGuardScopeCheck", () => {
  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockGetApiKeyForModel.mockClear();
    mockResolveModel.mockReset();
    mockResolveModel.mockImplementation((provider: string, modelId: string) => ({
      model: {
        provider,
        id: modelId,
        name: modelId,
        api: "openai-completions",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 8192,
      },
      authStorage: {},
      modelRegistry: {},
    }));
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: '{"allow":true,"reason":"needed for the requested task"}' }],
    } as never);
  });

  it("allows when guardian approves the source write", async () => {
    const result = await runImplementGuardScopeCheck({
      attemptedPaths: ["/tmp/workspace/src/operator-overview.ts"],
      guardTask: "fix latency display in operator-overview.ts",
      toolName: "edit",
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.2" } } } } as never,
      agentDir: "/tmp/agent",
    });

    expect(result).toEqual({
      allowed: true,
      reason: "needed for the requested task",
      modelRef: "openrouter/openrouter/hunter-alpha",
    });
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });

  it("blocks when guardian denies the source write", async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [
        { type: "text", text: '{"allow":false,"reason":"unrelated to the requested latency fix"}' },
      ],
    } as never);

    const result = await runImplementGuardScopeCheck({
      attemptedPaths: ["/tmp/workspace/src/agents/pi-tools.ts"],
      guardTask: "fix latency display in operator-overview.ts",
      toolName: "apply_patch",
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.2" } } } } as never,
      agentDir: "/tmp/agent",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "unrelated to the requested latency fix",
      modelRef: "openrouter/openrouter/hunter-alpha",
    });
  });

  it("blocks when no guardian-capable model can be resolved", async () => {
    mockResolveModel.mockReturnValue({
      error: "Unknown model",
      authStorage: {},
      modelRegistry: {},
    } as never);

    const result = await runImplementGuardScopeCheck({
      attemptedPaths: ["/tmp/workspace/src/operator-overview.ts"],
      guardTask: "fix latency display in operator-overview.ts",
      toolName: "edit",
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.2" } } } } as never,
      agentDir: "/tmp/agent",
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("expected blocked result");
    }
    expect(result.reason).toContain("no guardian model");
  });

  it("blocks when guardian returns invalid JSON", async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: "not-json" }],
    } as never);

    const result = await runImplementGuardScopeCheck({
      attemptedPaths: ["/tmp/workspace/src/operator-overview.ts"],
      guardTask: "fix latency display in operator-overview.ts",
      toolName: "edit",
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.2" } } } } as never,
      agentDir: "/tmp/agent",
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("expected blocked result");
    }
    expect(result.reason).toContain("guardian scope check failed");
  });
});
