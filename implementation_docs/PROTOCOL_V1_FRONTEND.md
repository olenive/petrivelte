# Protocol version 1 in the frontend

**Date:** 2026-10-03
**Status:** Design proposal, not yet implemented

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

- `fired {consumed, produced}`: stage one moves the consumed tokens from
  their places to the transition, stage two moves the produced ones out
  (`TOKEN_STAGE_MS` unchanged).
- `launched` then `distributed` (Rust nets): stage one on `launched`, stage
  two on `distributed`; the transition shows as in flight between them.
- `failed {restored, consumed}`: flash the transition; restored tokens
  travel back.
- `added`, `removed`, `mutated`: a token appears, disappears, or has its
  label replaced.

The page keeps a marking mirror: `count` per place (the truth) and the
capped token list. A produced token beyond the cap only raises the count.

### Consistency follows `marking_version`

State notifications raise `marking_version` by exactly one. The page applies
an event at its held version plus one, ignores older ones, and refetches
`/execution/state?protocol=1` on a gap, on `reloaded`, on `stream_gap`, and
on the reconnect and visibility triggers `workerStream.ts` already has. A
change of `generation` drops every token and cached token view.

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

`src/lib/types.ts` gains the version 1 shapes beside the version 0 ones
(`NetStateV1`, a discriminated union `NetEventV1` on `kind`), and
`api.ts` gains `?protocol=1` on the state read. `Place.x`, `Transition.x`
and the top-level `signature` fields go when version 0 is removed.

## Order

1. TypeScript layout, against today's server.
2. Version 1 types and the state read behind `?protocol=1`, with a
   `protocol_version` check that keeps the version 0 path working.
3. Event-driven animation, marking mirror and gap handling.
4. Transition state, inspector `detail`, enable and disable.
5. Remove the version 0 path when the server removes version 0.
