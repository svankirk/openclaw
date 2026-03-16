# Session Model Policy

This note proposes the first upstreamable step toward more reliable runtime model control.

## Problem

Today session model behavior is inferred indirectly:

- if a session has `providerOverride` / `modelOverride`, it is treated as pinned
- otherwise it follows agent defaults
- if a session has runtime `modelProvider` / `model`, status surfaces may show the last-used model even when the next turn should follow a newer default

That makes hot-swapping defaults hard to reason about, especially when clients want to distinguish:

- the model this session will use next
- the source of that choice
- the model used by the last completed run

## Proposal

Add an explicit session-level model policy:

- `modelMode: "inherit" | "pinned"`

Meaning:

- `inherit`: the next turn should follow agent/global defaults
- `pinned`: the next turn should use the session override

Gateway responses should also report where the effective model currently comes from:

- `modelSource: "default" | "pinned" | "runtime"`

Where:

- `default`: no runtime record and no active session pin
- `pinned`: effective next-turn selection comes from the session override
- `runtime`: the session has a recorded runtime model identity from the last run

## Compatibility

Older session entries do not have `modelMode`. For those entries:

- if `modelOverride` exists, infer `modelMode = "pinned"`
- otherwise infer `modelMode = "inherit"`

Existing `sessions.patch { model: ... }` behavior remains compatible:

- `model: null` clears the pin and switches to `inherit`
- `model: "<provider/model>"` sets the effective selection
- if the selected model equals the current default and `modelMode` is omitted, preserve legacy behavior and keep the session on `inherit`

New explicit controls:

- `sessions.patch { modelMode: "inherit" }` clears pins and follows defaults
- `sessions.patch { modelMode: "pinned" }` pins the current effective model when no explicit `model` is supplied

## Follow-on Work

This change is intentionally small. It prepares for later work:

- richer `sessions.list` / Control UI reporting
- default-model hot swap for inheriting sessions
- MCP or sidecar-driven model discovery and recommendation
