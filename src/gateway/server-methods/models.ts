import { listAgentIds, listAgentEntries } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  legacyModelKey,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  getConfigOverrides,
  loadConfig,
  setConfigOverride,
  unsetConfigOverride,
} from "../../config/config.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsDiscoverParams,
  validateModelsDefaultGetParams,
  validateModelsDefaultResetParams,
  validateModelsDefaultSetParams,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function mergePrimaryModelConfig(
  model: AgentModelConfig | undefined,
  primary: string,
): AgentModelConfig {
  const existing = toAgentModelListLike(model);
  return { ...existing, primary };
}

function resolveTargetAgentId(
  cfg: ReturnType<typeof loadConfig>,
  agentIdRaw?: string,
): string | undefined {
  const raw = agentIdRaw?.trim();
  if (!raw) {
    return undefined;
  }
  const agentId = normalizeAgentId(raw);
  const knownAgents = listAgentIds(cfg);
  if (!knownAgents.includes(agentId)) {
    return undefined;
  }
  return agentId;
}

function buildDefaultModelResponse(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId?: string;
  allowlistUpdated?: boolean;
}) {
  const targetAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const resolved = resolveDefaultModelForAgent({
    cfg: params.cfg,
    ...(targetAgentId ? { agentId: targetAgentId } : {}),
  });
  const overrides = getConfigOverrides() as {
    agents?: {
      defaults?: { model?: unknown };
      list?: Array<{ id?: string; model?: unknown }>;
    };
  };
  const source = targetAgentId
    ? overrides.agents?.defaults?.model ||
      overrides.agents?.list?.some(
        (entry) => normalizeAgentId(String(entry?.id ?? "")) === targetAgentId && entry?.model,
      )
      ? "runtimeOverride"
      : "config"
    : overrides.agents?.defaults?.model
      ? "runtimeOverride"
      : "config";
  return {
    ok: true as const,
    scope: targetAgentId ? ("agent" as const) : ("global" as const),
    ...(targetAgentId ? { agentId: targetAgentId } : {}),
    source,
    provider: resolved.provider,
    model: resolved.model,
    ref: modelKey(resolved.provider, resolved.model),
    ...(params.allowlistUpdated !== undefined ? { allowlistUpdated: params.allowlistUpdated } : {}),
  };
}

function ensureRuntimeAllowedModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  provider: string;
  model: string;
}): { updated: boolean; models?: Record<string, AgentModelEntryConfig> } {
  const existingModels = params.cfg.agents?.defaults?.models;
  if (!existingModels || Object.keys(existingModels).length === 0) {
    return { updated: false };
  }
  const canonicalKey = modelKey(params.provider, params.model);
  if (existingModels[canonicalKey]) {
    return { updated: false };
  }
  const legacyKey = legacyModelKey(params.provider, params.model);
  const nextModels = {
    ...existingModels,
  } as Record<string, AgentModelEntryConfig>;
  if (legacyKey && nextModels[legacyKey]) {
    nextModels[canonicalKey] = nextModels[legacyKey];
    delete nextModels[legacyKey];
    return { updated: true, models: nextModels };
  }
  nextModels[canonicalKey] = {};
  return { updated: true, models: nextModels };
}

function resolveRequestedModelOrError(params: {
  cfg: ReturnType<typeof loadConfig>;
  raw: string;
}): { provider: string; model: string } | { error: string } {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolved = resolveModelRefFromString({
    raw: params.raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  if (!resolved) {
    return { error: `invalid model: ${params.raw}` };
  }
  return resolved.ref;
}

function applyGlobalRuntimeDefaultModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  provider: string;
  model: string;
}): { allowlistUpdated: boolean } | { error: string } {
  const key = modelKey(params.provider, params.model);
  const nextModel = mergePrimaryModelConfig(params.cfg.agents?.defaults?.model, key);
  const modelResult = setConfigOverride("agents.defaults.model", nextModel);
  if (!modelResult.ok) {
    return { error: modelResult.error ?? "failed to set runtime default model" };
  }
  const allowlist = ensureRuntimeAllowedModel(params);
  if (allowlist.updated) {
    const modelsResult = setConfigOverride("agents.defaults.models", allowlist.models ?? {});
    if (!modelsResult.ok) {
      return { error: modelsResult.error ?? "failed to update runtime model allowlist" };
    }
  }
  return { allowlistUpdated: allowlist.updated };
}

function applyAgentRuntimeDefaultModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  provider: string;
  model: string;
}): { allowlistUpdated: boolean } | { error: string } {
  const list = listAgentEntries(params.cfg);
  const index = list.findIndex((entry) => normalizeAgentId(entry.id) === params.agentId);
  if (index < 0) {
    return { error: `unknown agent id "${params.agentId}"` };
  }
  const key = modelKey(params.provider, params.model);
  const nextList = [...list];
  nextList[index] = {
    ...nextList[index],
    model: mergePrimaryModelConfig(nextList[index].model, key),
  };
  const listResult = setConfigOverride("agents.list", nextList);
  if (!listResult.ok) {
    return { error: listResult.error ?? "failed to set runtime agent model" };
  }
  const allowlist = ensureRuntimeAllowedModel(params);
  if (allowlist.updated) {
    const modelsResult = setConfigOverride("agents.defaults.models", allowlist.models ?? {});
    if (!modelsResult.ok) {
      return { error: modelsResult.error ?? "failed to update runtime model allowlist" };
    }
  }
  return { allowlistUpdated: allowlist.updated };
}

function resetGlobalRuntimeDefaultModel(): { ok: true } | { error: string } {
  const result = unsetConfigOverride("agents.defaults.model");
  if (!result.ok) {
    return { error: result.error ?? "failed to clear runtime default model override" };
  }
  return { ok: true };
}

function resetAgentRuntimeDefaultModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
}): { ok: true } | { error: string } {
  const list = listAgentEntries(params.cfg);
  const index = list.findIndex((entry) => normalizeAgentId(entry.id) === params.agentId);
  if (index < 0) {
    return { error: `unknown agent id "${params.agentId}"` };
  }
  const nextList = [...list];
  const nextEntry = { ...nextList[index] } as (typeof nextList)[number] & { model?: unknown };
  delete nextEntry.model;
  nextList[index] = nextEntry;
  const result = setConfigOverride("agents.list", nextList);
  if (!result.ok) {
    return { error: result.error ?? "failed to clear runtime agent model override" };
  }
  return { ok: true };
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = loadConfig();
      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.discover": async ({ params, respond, context }) => {
    if (!validateModelsDiscoverParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.discover params: ${formatValidationErrors(validateModelsDiscoverParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog({
        refresh: params.refresh === true,
      });
      respond(true, { models: catalog }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.default.get": ({ params, respond }) => {
    if (!validateModelsDefaultGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.default.get params: ${formatValidationErrors(validateModelsDefaultGetParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveTargetAgentId(cfg, params.agentId);
    const requestedAgentId = typeof params.agentId === "string" ? params.agentId : undefined;
    if (requestedAgentId && !agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
      );
      return;
    }
    respond(true, buildDefaultModelResponse({ cfg, ...(agentId ? { agentId } : {}) }), undefined);
  },
  "models.default.set": ({ params, respond }) => {
    if (!validateModelsDefaultSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.default.set params: ${formatValidationErrors(validateModelsDefaultSetParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveTargetAgentId(cfg, params.agentId);
    const requestedAgentId = typeof params.agentId === "string" ? params.agentId : undefined;
    if (requestedAgentId && !agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
      );
      return;
    }
    const requested = resolveRequestedModelOrError({ cfg, raw: params.model });
    if ("error" in requested) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, requested.error));
      return;
    }
    const update = agentId
      ? applyAgentRuntimeDefaultModel({ cfg, agentId, ...requested })
      : applyGlobalRuntimeDefaultModel({ cfg, ...requested });
    if ("error" in update) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, update.error));
      return;
    }
    respond(
      true,
      buildDefaultModelResponse({
        cfg: loadConfig(),
        ...(agentId ? { agentId } : {}),
        allowlistUpdated: update.allowlistUpdated,
      }),
      undefined,
    );
  },
  "models.default.reset": ({ params, respond }) => {
    if (!validateModelsDefaultResetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.default.reset params: ${formatValidationErrors(validateModelsDefaultResetParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveTargetAgentId(cfg, params.agentId);
    const requestedAgentId = typeof params.agentId === "string" ? params.agentId : undefined;
    if (requestedAgentId && !agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
      );
      return;
    }
    const reset = agentId
      ? resetAgentRuntimeDefaultModel({ cfg, agentId })
      : resetGlobalRuntimeDefaultModel();
    if ("error" in reset) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, reset.error));
      return;
    }
    respond(
      true,
      buildDefaultModelResponse({ cfg: loadConfig(), ...(agentId ? { agentId } : {}) }),
      undefined,
    );
  },
};
