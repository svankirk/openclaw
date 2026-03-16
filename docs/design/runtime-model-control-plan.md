# Runtime Model Control Plan

This document describes an upstream-friendly path toward live model discovery and hot model switching without making static config rewrites the primary control surface.

## Goals

- support hot model switching for new work without restarting the gateway
- make session behavior explicit when defaults change
- expose the effective model and why it was chosen
- leave provider discovery extensible enough to support local backends and hosted catalogs

## Scope boundaries

OpenClaw should own runtime model resolution for sessions and requests.

OpenClaw does not need to become the full long-term model catalog/control plane. Rich discovery, operator ranking, benchmarking, and provider-specific metadata can live in a sidecar or MCP server later.

## Implementation phases

### Phase 1: explicit session model policy

Implemented in this branch.

- add `modelMode: "inherit" | "pinned"` to session entries
- infer legacy entries from existing overrides
- report `modelSource: "default" | "pinned" | "runtime"` in `sessions.list`
- allow `sessions.patch` to switch between inheriting and pinned behavior

This removes ambiguity when a session should follow a changed default versus keep a session-local pin.

### Phase 2: runtime config overrides

Implemented in this branch.

- add `config.overrides.get`
- add `config.overrides.set`
- add `config.overrides.unset`
- add `config.overrides.reset`
- extend `config.get` with:
  - `runtimeOverrides`
  - `effectiveConfig`

The intent is to support hot default changes for the running gateway without writing `openclaw.json` for every switch.

This is the runtime primitive needed for switching `agents.defaults.model.primary` or per-agent defaults while keeping the on-disk config unchanged.

### Phase 3: runtime default model API

Implemented in this branch as the first semantic gateway surface.

- add `models.default.get`
- add `models.default.set`
- add `models.default.reset`
- use the runtime override layer internally instead of exposing config-path knowledge to all clients
- support:
  - global default
  - agent default

This keeps model switching semantic and stable even if config layout changes again.

### Phase 4: provider discovery contract

Recommended upstream design work.

- add a provider/plugin contract for live model discovery
- normalize basic fields:
  - `provider`
  - `id`
  - `displayName`
  - `contextWindow`
  - `maxTokens`
  - `modalities`
  - `reasoning`
  - `health`

This should stay intentionally small. Rich provider metadata can be optional.

### Phase 5: operator-side catalog and recommendation layer

Recommended sidecar/MCP work.

- aggregate models from Ollama, vLLM, LM Studio, llama.cpp, OpenRouter
- add richer metadata such as price, latency, throughput, and local availability
- let WebClaw or an MCP client recommend and select models using OpenClaw runtime APIs

This layer should consume OpenClaw runtime switching, not replace it.

## Design rules

- do not require a gateway restart for model switches
- do not require a disk config write for routine model switches
- separate:
  - disk config
  - runtime overrides
  - effective config
  - session pins
  - last-used runtime model identity
- keep provider discovery pluggable and narrow

## Why this direction

OpenClaw changes quickly. Static config schemas and migrations are not a stable control plane.

By isolating:

- session pin/inherit semantics
- runtime override state
- effective model reporting

we make OpenClaw easier to integrate with external catalogs and operator tooling while still landing changes that are useful on their own upstream.
