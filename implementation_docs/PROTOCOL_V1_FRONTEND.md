# Protocol version 1 in the frontend

**Date:** 2026-10-03, revised 2026-10-04 after the server moved to version 1
**Status:** Design proposal, not yet implemented. Revised in lockstep with the
server: there is no version 0 path to keep, no `?protocol=1`, and the server
no longer sends `x` and `y`, so the layout (slice 1) and the version 1 page
(slice 3) land together before the next deploy of either.

The net protocol is specified once, in the Python library:
[`../../petritype/PROTOCOL.md`](../../petritype/PROTOCOL.md)
(<https://github.com/olenive/petritype/blob/main/PROTOCOL.md>). The server's
side, including the table of what changes from today's contract (version 0),
is `../../petritype-server/dev-docs/RUNTIMES_AND_PROTOCOL.md`. This note
covers only the frontend. `COMS.md` keeps describing what the frontend
relies on today and is updated when this lands.

## Context

A net can now run on the Python library or the Rust crate, and be viewed
here or in the Bevy visualiser. The server relays one protocol for both
runtimes, so this page must stop depending on what only Python sends:
memory-address token ids, server-computed coordinates, the whole capped
marking on every firing, and top-level Python introspection fields.

## Decisions

### Layout moves into the frontend, first

**Decided 2026-10-03** (layout belongs to the viewer). The server stops
sending `x` and `y`. `GraphPanel.svelte` gets its coordinates from a layered
layout in TypeScript, `src/lib/layout.ts`, a port of the Bevy visualiser's
`src/layout.rs`: break cycles by depth-first search in declaration order
(back edges drawn curved, ignored for ranking), rank by longest path,
order within a rank by barycentre sweeps, then centre. Chosen over dagre
because both viewers then draw the same net the same way, it is about 300
lines with no dependency, and it is deterministic.

- Position hints (`topology.hints.positions`), when present, pin those
  nodes; the rest are laid out around them.
- This step ships before anything else and works against today's server
  (it simply ignores `x` and `y`), so the server can drop grandalf without
  breaking this page.

### Tokens are keyed by their id

Version 1 token ids are decimal strings that are never reused within a
generation. Animations, `AnimatingToken` keys, the token inspector's cache
and the selection key by `(generation, id)`. The comment in
`TokenInspector.svelte` about an id "whose underlying token was consumed
and replaced" no longer applies and goes.

### Firings are animated from the event, not inferred

Today `nets/+page.svelte` (around lines 780 to 810) compares the old and new
token id sets from `new_token_positions` to guess what was consumed,
produced and moved. Version 1 says it:

- `launched` then `distributed` (both runners since 2026-10-04): stage one on
  `launched`, stage two on `distributed`; the transition shows as in flight
  between them.
- `fired {consumed, produced}` (legal for a one-piece runtime, sent by
  neither runner): stage one moves the consumed tokens from their places to
  the transition, stage two moves the produced ones out (`TOKEN_STAGE_MS`
  unchanged). Decoded and played back, as the Bevy viewer does.
- `failed {restored, consumed}`: flash the transition; restored tokens
  travel back.
- `added`, `removed`, `mutated`: a token appears, disappears, or has its
  label replaced.

The page keeps a marking mirror: `count` per place (the truth) and the
capped token list. A produced token beyond the cap only raises the count.

### Consistency follows `marking_version`

State notifications raise `marking_version` by exactly one. The page applies
an event at its held version plus one, ignores older ones, and refetches
`/execution/state` on a gap, on `reloaded`, on `stream_gap`, and on the
reconnect and visibility triggers `workerStream.ts` already has. A change of
`generation` drops every token and cached token view.

### What the server sends now (2026-10-04)

Settled on the server side, in `../../petritype-server/dev-docs/RUNTIMES_AND_PROTOCOL.md`:

- **The worker stream carries the protocol's notifications as its kinds**,
  `data` being the params: `launched`, `distributed`, `fired`, `failed`,
  `added`, `removed`, `mutated`, `toggled`, `param_changed` (each moves
  `marking_version` by one), `reloaded` (refetch), `fireable`, `idle`,
  `execution_stopped {reason: no_fireable_transitions | transition_failed |
  subprocess_exited, error_type?, message?}`, `heartbeat`, `load_progress`;
  plus the host's own `subprocess_output`, `memory_stats`, `log`,
  `stream_gap`. `transition_fired`, `step_started`, `step_completed`,
  `step_error`, `graph_state` and `net_reset` are gone: the page stops
  handling them, and the step spinner is the page's own request in flight.
- **`POST .../execution/step` answers the protocol's result** `{fired,
  transition?, failed?, marking_version, running}` once the firing has
  landed, or `504 {detail, reason: "timeout"}` after fifteen seconds while
  the firing runs on and lands on the stream. The page treats the timeout as
  "still in progress", not as a failure.
- **Protocol errors** arrive as `{detail, reason}` with `reason` the protocol
  code: 404 `unknown_net | unknown_place | unknown_transition |
  unknown_token`, 422 `invalid_params | invalid_token | not_serializable |
  load_failed`, 501 `unsupported | unknown_method`, 409 `not_loaded`, 500
  `internal`. `NetProxyError` gains these reasons.
- **Bodies:** `inject {place, token}` answers `{status, id,
  marking_version}`; `GET .../execution/history?after=&limit=` answers
  `{entries}` (the protocol's log, consumed and produced as place and id
  pairs); `GET .../tokens/{id}` answers `{id, place, type_name, kind:
  "json", value}` or `{..., kind: "text", text}`; `GET
  .../execution/state?token_limit=` answers the protocol's state
  (`marking.places[name].{count, tokens}`, `transitions[name].{enabled,
  fireable, in_flight, priority?}`, `topology`, `progress`, `generation`,
  `marking_version`, `running`, `runtime`); `POST
  .../transitions/{name}/enable|disable` answer `{marking_version}`.
- **The browser suite's fake control plane** (`tests/ui/fake_cp.py`) speaks
  version 1 from slice 3 on, both streams included.

### Transitions show their state and their detail

- Transition styling reads `transitions[name]`: disabled (grey, dashed),
  fireable, in flight, as the Bevy view does. The `fireable` notification
  keeps it fresh.
- `TransitionInspector.svelte` shows `detail` when present, as rows: for a
  Python net that is `function_name`, `signature` and `docstring`, as
  today; for a Rust net the parameter types. With no `detail` it shows the
  transition's input and output places from the topology instead of "No
  signature available".
- Enable and disable buttons in the inspector call the new
  `POST /api/nets/{id}/transitions/{name}/enable|disable`.

### Small things

- A runtime badge (`python`, `rust`) from the state's `runtime`.
- The inject form is offered only for places with `serializable: true`.
- `ExecutionLog.svelte` shows `consumed` and `produced` as place and id;
  argument names and the `Type@timestamp_hash` ids are gone.
- Read edges (`snapshot`, `mutate`) are now in the topology and are drawn
  dashed and dotted, as the Bevy and Graphviz renderers draw them.

## Types

`src/lib/types.ts` holds the version 1 shapes (`NetState`, a discriminated
union `NetEvent` on `kind`) in place of the version 0 ones. `Place.x`,
`Transition.x`, `preview`, `token_count` and the top-level `signature`
fields go with them.

## Order

Two slices, each approved before it starts, each with tests (2026-10-04):

1. **Slice 1, the TypeScript layout:** `src/lib/layout.ts`, a port of the
   Bevy visualiser's `src/layout.rs`, over a neutral input (place names,
   transition names, directed edges, optional pinned positions) so the page
   feeds it from whichever topology shape it holds; `GraphPanel.svelte` takes
   its coordinates from it and ignores `x` and `y`.
2. **Slice 3, the version 1 page:** the types; the state read, the event
   handler and the marking mirror with the version rule; event-driven
   animation for both firing shapes; transition state and the inspector's
   `detail`; enable and disable; the execution log on `{entries}`; the
   runtime badge; inject by `place` for serializable places; `NetProxyError`
   on the new reasons and the step timeout; `COMS.md` rewritten for the
   version 1 proxy and stream; the fake control plane on version 1; the
   version 0 types and handlers removed.

(Slice 2 of the programme is the server's, landed 2026-10-04.)
