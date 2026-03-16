import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { normalizeModelSelection, parseModelRef } from "../agents/model-selection.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sessions/guard-guardian");
const GUARDIAN_TIMEOUT_MS = 12_000;
const DEFAULT_GUARDIAN_MODEL_REFS = [
  "openrouter/openrouter/hunter-alpha",
  "modelstudio/qwen3.5-plus",
];

type GuardianRuntime = {
  apiKey: string;
  model: Model<Api>;
  modelRef: string;
};

export type ImplementScopeDecision =
  | { allowed: true; reason: string; modelRef: string }
  | { allowed: false; reason: string; modelRef?: string };

function extractAssistantText(
  content: Array<{ type?: string; text?: string }> | undefined,
): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function resolveGuardianRuntime(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<GuardianRuntime | null> {
  const configuredPrimary = normalizeModelSelection(
    resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.model),
  );
  const candidates = Array.from(
    new Set(
      [...DEFAULT_GUARDIAN_MODEL_REFS, configuredPrimary ?? ""]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  for (const modelRef of candidates) {
    const parsed = parseModelRef(modelRef, "openai");
    if (!parsed) {
      continue;
    }
    const resolved = resolveModel(parsed.provider, parsed.model, params.agentDir, params.cfg);
    if (!resolved.model) {
      continue;
    }
    try {
      const auth = await getApiKeyForModel({
        model: resolved.model,
        cfg: params.cfg,
        agentDir: params.agentDir,
      });
      return {
        apiKey: requireApiKey(auth, resolved.model.provider),
        model: resolved.model,
        modelRef: `${parsed.provider}/${parsed.model}`,
      };
    } catch (err) {
      log.debug(`guardian skipped model ${modelRef}: ${String(err)}`);
    }
  }

  return null;
}

function buildGuardianPrompt(params: {
  guardTask: string;
  attemptedPaths: string[];
  toolName: string;
  workspaceDir?: string;
  sessionKey?: string;
}): string {
  return [
    "You are a conservative filesystem scope judge.",
    "Decide whether the attempted source-code write is clearly within the allowed implement task.",
    "Allow only if every path is directly necessary for the stated task.",
    "If uncertain, allow=false.",
    'Return ONLY JSON with this exact shape: {"allow":boolean,"reason":string}.',
    "",
    `Task: ${params.guardTask}`,
    `Tool: ${params.toolName}`,
    `Session: ${params.sessionKey ?? "unknown"}`,
    `Workspace: ${params.workspaceDir ?? "unknown"}`,
    `Paths: ${params.attemptedPaths.join(", ")}`,
  ].join("\n");
}

export async function runImplementGuardScopeCheck(params: {
  attemptedPaths: string[];
  guardTask: string;
  toolName: string;
  sessionKey?: string;
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  completeSimpleImpl?: typeof completeSimple;
  resolveGuardianRuntimeImpl?: typeof resolveGuardianRuntime;
}): Promise<ImplementScopeDecision> {
  const attemptedPaths = params.attemptedPaths.map((value) => value.trim()).filter(Boolean);
  const guardTask = params.guardTask.trim();
  if (!guardTask) {
    return {
      allowed: false,
      reason: "Blocked guard check: implement mode source writes require a guardTask.",
    };
  }
  if (attemptedPaths.length === 0) {
    return {
      allowed: false,
      reason: "Blocked guard check: no target paths available for guardian scope review.",
    };
  }

  const resolveRuntime = params.resolveGuardianRuntimeImpl ?? resolveGuardianRuntime;
  const runtime = await resolveRuntime({ cfg: params.cfg, agentDir: params.agentDir });
  if (!runtime) {
    return {
      allowed: false,
      reason:
        "Blocked source write: no guardian model with usable auth is available for implement-mode scope checks.",
    };
  }

  try {
    const completion = await withTimeout(
      (params.completeSimpleImpl ?? completeSimple)(
        runtime.model,
        {
          messages: [
            {
              role: "user",
              content: buildGuardianPrompt({
                guardTask,
                attemptedPaths,
                toolName: params.toolName,
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
              }),
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: runtime.apiKey,
          maxTokens: 160,
          temperature: 0,
        },
      ),
      GUARDIAN_TIMEOUT_MS,
      "guardian scope check",
    );

    const rawText = extractAssistantText(completion.content);
    const jsonText = extractBalancedJsonObject(rawText) ?? rawText;
    const parsed = JSON.parse(jsonText) as { allow?: unknown; reason?: unknown };
    if (typeof parsed.allow !== "boolean") {
      return {
        allowed: false,
        modelRef: runtime.modelRef,
        reason: "Blocked source write: guardian returned an invalid scope decision.",
      };
    }
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : parsed.allow
          ? "guardian approved requested source write"
          : "guardian denied requested source write";
    return parsed.allow
      ? { allowed: true, reason, modelRef: runtime.modelRef }
      : { allowed: false, reason, modelRef: runtime.modelRef };
  } catch (err) {
    return {
      allowed: false,
      modelRef: runtime.modelRef,
      reason: `Blocked source write: guardian scope check failed (${String(err)}).`,
    };
  }
}
