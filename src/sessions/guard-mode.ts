import path from "node:path";
import type { SessionEntry } from "../config/sessions.js";

export type GuardMode = NonNullable<SessionEntry["guardMode"]>;

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
]);

const WRITE_TOOL_NAMES = new Set(["write", "edit", "apply_patch"]);
const WATCH_SURFACE_TOKENS = ["webclaw", "gateway-client", "webchat"];

export function normalizeGuardMode(value: unknown): GuardMode | undefined {
  const normalized = (typeof value === "string" ? value : "").trim().toLowerCase();
  if (normalized === "watch" || normalized === "assist" || normalized === "implement") {
    return normalized;
  }
  return undefined;
}

export function resolveDefaultGuardMode(params: {
  sessionKey?: string;
  entry?: Pick<SessionEntry, "label" | "channel" | "origin">;
}): GuardMode {
  const haystacks = [
    params.sessionKey,
    params.entry?.label,
    params.entry?.channel,
    params.entry?.origin?.label,
    params.entry?.origin?.surface,
    params.entry?.origin?.provider,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  return haystacks.some((value) => WATCH_SURFACE_TOKENS.some((token) => value.includes(token)))
    ? "watch"
    : "assist";
}

function normalizeAbsolutePath(input: string): string {
  return path.resolve(input.trim());
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isSourceCodePath(candidate: string): boolean {
  const normalized = normalizeAbsolutePath(candidate);
  const ext = path.extname(normalized).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) {
    return true;
  }
  const segments = new Set(normalized.split(path.sep).filter(Boolean));
  return segments.has("dev") || segments.has("src");
}

function isAssistWritableWorkspacePath(workspaceDir: string, candidate: string): boolean {
  const workspaceRoot = normalizeAbsolutePath(workspaceDir);
  const absolute = normalizeAbsolutePath(candidate);
  if (!isPathWithinRoot(workspaceRoot, absolute)) {
    return false;
  }
  const relative = path.relative(workspaceRoot, absolute);
  const normalizedRelative = relative.split(path.sep).join("/");
  if (normalizedRelative === "memory" || normalizedRelative.startsWith("memory/")) {
    return true;
  }
  if (normalizedRelative === "research" || normalizedRelative.startsWith("research/")) {
    return true;
  }
  if (!normalizedRelative.includes("/") && normalizedRelative.toLowerCase().endsWith(".md")) {
    return true;
  }
  return false;
}

export function extractGuardedToolPaths(toolName: string, params: unknown): string[] {
  const normalizedTool = String(toolName || "")
    .trim()
    .toLowerCase();
  if (!WRITE_TOOL_NAMES.has(normalizedTool)) {
    return [];
  }
  if (!params || typeof params !== "object") {
    return [];
  }
  const record = params as Record<string, unknown>;
  const direct = [record.path, record.file_path, record.filePath, record.target]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (direct.length > 0) {
    return direct;
  }
  if (normalizedTool !== "apply_patch") {
    return [];
  }
  const patch = typeof record.patch === "string" ? record.patch : "";
  if (!patch.trim()) {
    return [];
  }
  const matches = patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm);
  const paths: string[] = [];
  for (const match of matches) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) {
      paths.push(candidate);
    }
  }
  return paths;
}

export type GuardDecision =
  | { allowed: true; mode: GuardMode }
  | {
      allowed: false;
      mode: GuardMode;
      reason: string;
      attemptedPaths: string[];
    };

export function evaluateGuardedWriteAccess(params: {
  toolName: string;
  toolParams: unknown;
  workspaceDir?: string;
  sessionKey?: string;
  entry?: Pick<SessionEntry, "guardMode" | "guardTask" | "label" | "channel" | "origin">;
}): GuardDecision {
  const toolName = String(params.toolName || "")
    .trim()
    .toLowerCase();
  if (!WRITE_TOOL_NAMES.has(toolName)) {
    return { allowed: true, mode: normalizeGuardMode(params.entry?.guardMode) ?? "assist" };
  }

  const mode =
    normalizeGuardMode(params.entry?.guardMode) ??
    resolveDefaultGuardMode({ sessionKey: params.sessionKey, entry: params.entry });
  const attemptedPaths = extractGuardedToolPaths(toolName, params.toolParams);

  if (toolName === "apply_patch") {
    if (mode === "implement") {
      if (attemptedPaths.length === 0) {
        return {
          allowed: false,
          mode,
          reason: `Blocked ${toolName}: could not determine target path in ${mode} mode.`,
          attemptedPaths,
        };
      }
      for (const attemptedPath of attemptedPaths) {
        if (!isSourceCodePath(attemptedPath)) {
          continue;
        }
        const guardTask = params.entry?.guardTask?.trim();
        if (!guardTask) {
          return {
            allowed: false,
            mode,
            reason: `Blocked ${toolName}: implement mode source writes require a guardTask.`,
            attemptedPaths,
          };
        }
      }
      return { allowed: true, mode };
    }
    return {
      allowed: false,
      mode,
      reason: `Blocked ${toolName}: ${mode} mode does not allow apply_patch.`,
      attemptedPaths,
    };
  }

  if (attemptedPaths.length === 0) {
    return {
      allowed: false,
      mode,
      reason: `Blocked ${toolName}: could not determine target path in ${mode} mode.`,
      attemptedPaths,
    };
  }

  if (mode === "watch") {
    return {
      allowed: false,
      mode,
      reason: `Blocked ${toolName}: watch mode does not allow file writes.`,
      attemptedPaths,
    };
  }

  if (mode === "implement") {
    for (const attemptedPath of attemptedPaths) {
      if (!isSourceCodePath(attemptedPath)) {
        continue;
      }
      const guardTask = params.entry?.guardTask?.trim();
      if (!guardTask) {
        return {
          allowed: false,
          mode,
          reason: `Blocked ${toolName}: implement mode source writes require a guardTask.`,
          attemptedPaths,
        };
      }
    }
    return { allowed: true, mode };
  }

  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return {
      allowed: false,
      mode,
      reason: `Blocked ${toolName}: no workspace root available for assist-mode guard.`,
      attemptedPaths,
    };
  }

  for (const attemptedPath of attemptedPaths) {
    if (isSourceCodePath(attemptedPath)) {
      return {
        allowed: false,
        mode,
        reason: `Blocked ${toolName}: source-code paths require implement mode.`,
        attemptedPaths,
      };
    }
    if (!isAssistWritableWorkspacePath(workspaceDir, attemptedPath)) {
      return {
        allowed: false,
        mode,
        reason:
          `Blocked ${toolName}: assist mode only allows workspace memory/research paths ` +
          `and top-level Markdown files.`,
        attemptedPaths,
      };
    }
  }

  return { allowed: true, mode };
}
