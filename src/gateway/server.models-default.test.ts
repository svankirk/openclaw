import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearConfigCache } from "../config/config.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startedServer: Awaited<ReturnType<typeof startServerWithClient>> | null = null;

function requireWs(): Awaited<ReturnType<typeof startServerWithClient>>["ws"] {
  if (!startedServer) {
    throw new Error("gateway test server not started");
  }
  return startedServer.ws;
}

async function withModelsConfig<T>(config: unknown, run: () => Promise<T>): Promise<T> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Missing OPENCLAW_CONFIG_PATH");
  }
  let previousConfig: string | undefined;
  try {
    previousConfig = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
    clearConfigCache();
    return await run();
  } finally {
    if (previousConfig === undefined) {
      await fs.rm(configPath, { force: true });
    } else {
      await fs.writeFile(configPath, previousConfig, "utf-8");
    }
    clearConfigCache();
  }
}

beforeAll(async () => {
  startedServer = await startServerWithClient(undefined, { controlUiEnabled: true });
  await connectOk(requireWs());
});

afterAll(async () => {
  if (!startedServer) {
    return;
  }
  startedServer.ws.close();
  await startedServer.server.close();
  startedServer = null;
});

describe("gateway runtime default model methods", () => {
  it("hot-swaps the global default model without touching disk config", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-test-a" },
            models: {
              "anthropic/claude-test-a": {},
            },
          },
        },
      },
      async () => {
        const initial = await rpcReq<{
          ref: string;
          source: "config" | "runtimeOverride";
          scope: "global" | "agent";
        }>(requireWs(), "models.default.get", {});
        expect(initial.ok).toBe(true);
        expect(initial.payload).toMatchObject({
          scope: "global",
          source: "config",
          ref: "anthropic/claude-test-a",
        });

        const switched = await rpcReq<{
          ref: string;
          source: "config" | "runtimeOverride";
          allowlistUpdated?: boolean;
        }>(requireWs(), "models.default.set", {
          model: "openai/gpt-test-a",
        });
        expect(switched.ok).toBe(true);
        expect(switched.payload).toMatchObject({
          source: "runtimeOverride",
          ref: "openai/gpt-test-a",
          allowlistUpdated: true,
        });

        const configRes = await rpcReq<{
          config?: { agents?: { defaults?: { model?: { primary?: string } } } };
          effectiveConfig?: { agents?: { defaults?: { model?: { primary?: string } } } };
          runtimeOverrides?: {
            agents?: {
              defaults?: {
                model?: { primary?: string };
                models?: Record<string, unknown>;
              };
            };
          };
        }>(requireWs(), "config.get", {});
        expect(configRes.ok).toBe(true);
        expect(configRes.payload?.config?.agents?.defaults?.model?.primary).toBe(
          "anthropic/claude-test-a",
        );
        expect(configRes.payload?.effectiveConfig?.agents?.defaults?.model?.primary).toBe(
          "openai/gpt-test-a",
        );
        expect(configRes.payload?.runtimeOverrides?.agents?.defaults?.models).toMatchObject({
          "openai/gpt-test-a": {},
        });

        const reset = await rpcReq<{
          ref: string;
          source: "config" | "runtimeOverride";
        }>(requireWs(), "models.default.reset", {});
        expect(reset.ok).toBe(true);
        expect(reset.payload).toMatchObject({
          source: "config",
          ref: "anthropic/claude-test-a",
        });
      },
    );
  });

  it("supports agent-scoped runtime default switches without affecting other agents", async () => {
    await withModelsConfig(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-test-a" },
            models: {
              "anthropic/claude-test-a": {},
              "openai/gpt-test-a": {},
            },
          },
          list: [{ id: "home", default: true }, { id: "work" }],
        },
      },
      async () => {
        const switched = await rpcReq<{
          agentId?: string;
          ref: string;
          scope: "global" | "agent";
          source: "config" | "runtimeOverride";
        }>(requireWs(), "models.default.set", {
          agentId: "work",
          model: "openai/gpt-test-a",
        });
        expect(switched.ok).toBe(true);
        expect(switched.payload).toMatchObject({
          scope: "agent",
          agentId: "work",
          source: "runtimeOverride",
          ref: "openai/gpt-test-a",
        });

        const work = await rpcReq<{ agentId?: string; ref: string }>(
          requireWs(),
          "models.default.get",
          {
            agentId: "work",
          },
        );
        expect(work.ok).toBe(true);
        expect(work.payload).toMatchObject({
          agentId: "work",
          ref: "openai/gpt-test-a",
        });

        const home = await rpcReq<{ agentId?: string; ref: string }>(
          requireWs(),
          "models.default.get",
          {
            agentId: "home",
          },
        );
        expect(home.ok).toBe(true);
        expect(home.payload).toMatchObject({
          agentId: "home",
          ref: "anthropic/claude-test-a",
        });

        const globalDefault = await rpcReq<{ ref: string }>(requireWs(), "models.default.get", {});
        expect(globalDefault.ok).toBe(true);
        expect(globalDefault.payload?.ref).toBe("anthropic/claude-test-a");

        const reset = await rpcReq<{ agentId?: string; ref: string; source: string }>(
          requireWs(),
          "models.default.reset",
          { agentId: "work" },
        );
        expect(reset.ok).toBe(true);
        expect(reset.payload).toMatchObject({
          agentId: "work",
          source: "config",
          ref: "anthropic/claude-test-a",
        });
      },
    );
  });
});
