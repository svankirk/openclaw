import type { OpenClawConfig } from "../config/config.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { appendInjectedAssistantMessageToTranscript } from "../gateway/server-methods/chat-transcript-inject.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runImplementGuardScopeCheck } from "../sessions/guard-mode.guardian.js";
import {
  evaluateGuardedWriteAccess,
  extractGuardedToolPaths,
  isSourceCodePath,
  type GuardMode,
} from "../sessions/guard-mode.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type HookContext = {
  agentId?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  loopDetection?: ToolLoopDetectionConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
let beforeToolCallRuntimePromise: Promise<
  typeof import("./pi-tools.before-tool-call.runtime.js")
> | null = null;

function loadBeforeToolCallRuntime() {
  beforeToolCallRuntimePromise ??= import("./pi-tools.before-tool-call.runtime.js");
  return beforeToolCallRuntimePromise;
}

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

function buildFenceBlockMessage(params: {
  toolName: string;
  mode: GuardMode;
  reason: string;
  attemptedPaths: string[];
}): string {
  const target = params.attemptedPaths.length > 0 ? params.attemptedPaths.join(", ") : "<unknown>";
  return [
    `[fence_block] ${params.toolName} blocked in ${params.mode} mode.`,
    `Target: ${target}`,
    params.reason,
  ].join("\n");
}

function emitFenceBlockTelemetry(args: {
  ctx?: HookContext;
  toolName: string;
  mode: GuardMode;
  reason: string;
  attemptedPaths: string[];
}) {
  if (!args.ctx?.runId) {
    return;
  }
  emitAgentEvent({
    runId: args.ctx.runId,
    sessionKey: args.ctx.sessionKey,
    stream: "tool",
    data: {
      phase: "fence_block",
      name: args.toolName,
      guardMode: args.mode,
      attemptedPath: args.attemptedPaths[0],
      attemptedPaths: args.attemptedPaths,
      reason: args.reason,
    },
  });
}

function persistFenceBlockToTranscript(args: {
  ctx?: HookContext;
  toolName: string;
  mode: GuardMode;
  reason: string;
  attemptedPaths: string[];
}) {
  const sessionKey = args.ctx?.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  try {
    const { entry } = loadSessionEntry(sessionKey);
    const transcriptPath = typeof entry?.sessionFile === "string" ? entry.sessionFile.trim() : "";
    if (!transcriptPath) {
      return;
    }
    appendInjectedAssistantMessageToTranscript({
      transcriptPath,
      message: buildFenceBlockMessage({
        toolName: args.toolName,
        mode: args.mode,
        reason: args.reason,
        attemptedPaths: args.attemptedPaths,
      }),
      label: "Fence block",
      idempotencyKey: [
        args.ctx?.runId ?? "run",
        args.toolName,
        args.mode,
        args.attemptedPaths.join("|") || "unknown",
      ].join(":"),
    });
  } catch (err) {
    log.warn(`fence block transcript append failed: tool=${args.toolName} error=${String(err)}`);
  }
}

function tryLoadSessionEntry(sessionKey?: string) {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return undefined;
  }
  try {
    return loadSessionEntry(normalized).entry;
  } catch (err) {
    log.warn(`guard mode session lookup failed: sessionKey=${normalized} error=${String(err)}`);
    return undefined;
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;
  const entry = tryLoadSessionEntry(args.ctx?.sessionKey);
  const guardedWrite = evaluateGuardedWriteAccess({
    toolName,
    toolParams: params,
    workspaceDir: args.ctx?.workspaceDir,
    sessionKey: args.ctx?.sessionKey,
    entry,
  });
  if (!guardedWrite.allowed) {
    emitFenceBlockTelemetry({
      ctx: args.ctx,
      toolName,
      mode: guardedWrite.mode,
      reason: guardedWrite.reason,
      attemptedPaths: guardedWrite.attemptedPaths,
    });
    persistFenceBlockToTranscript({
      ctx: args.ctx,
      toolName,
      mode: guardedWrite.mode,
      reason: guardedWrite.reason,
      attemptedPaths: guardedWrite.attemptedPaths,
    });
    return {
      blocked: true,
      reason: guardedWrite.reason,
    };
  }

  if (guardedWrite.mode === "implement") {
    const attemptedPaths = extractGuardedToolPaths(toolName, params).filter(isSourceCodePath);
    if (attemptedPaths.length > 0) {
      const guardTask = entry?.guardTask?.trim();
      const guardianDecision = await runImplementGuardScopeCheck({
        attemptedPaths,
        guardTask: guardTask ?? "",
        toolName,
        sessionKey: args.ctx?.sessionKey,
        workspaceDir: args.ctx?.workspaceDir,
        cfg: args.ctx?.config,
        agentDir: args.ctx?.agentDir,
      });
      if (!guardianDecision.allowed) {
        emitFenceBlockTelemetry({
          ctx: args.ctx,
          toolName,
          mode: "implement",
          reason: guardianDecision.reason,
          attemptedPaths,
        });
        persistFenceBlockToTranscript({
          ctx: args.ctx,
          toolName,
          mode: "implement",
          reason: guardianDecision.reason,
          attemptedPaths,
        });
        return {
          blocked: true,
          reason: guardianDecision.reason,
        };
      }
    }
  }

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx?.agentId,
            toolName,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId ? { agentId: args.ctx.agentId } : {}),
      ...(args.ctx?.sessionKey ? { sessionKey: args.ctx.sessionKey } : {}),
      ...(args.ctx?.sessionId ? { sessionId: args.ctx.sessionId } : {}),
      ...(args.ctx?.runId ? { runId: args.ctx.runId } : {}),
      ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    };
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
        ...(args.ctx?.runId ? { runId: args.ctx.runId } : {}),
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
        adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
