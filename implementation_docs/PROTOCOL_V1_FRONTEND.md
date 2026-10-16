# Protocol version 1 in the frontend

**Date:** 2026-10-03, revised 2026-10-04 after the server moved to version 1
**Status:** Implemented 2026-10-04: slice 1 (the layout) and slice 3 (the version 1 page) landed.

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

## Inner nets and keys in the page (2026-10-12)

**Status:** Implemented 2026-10-12 on branch `nested-and-keys`, against the
relay petritype-server builds the same day (its
`dev-docs/RUNTIMES_AND_PROTOCOL.md`, "Nested nets, keys and the projection
through the relay, 12 October 2026"). Protocol §12 (nested nets) and §13
(keys, queries, filters). The Bevy viewer does the same things in its
DESIGN §3.5 and §3.6, and the two are meant to feel alike.

### What the wire gives the page

- `topology.places[]` may say `nested`, `passive` and `key_names`; a token
  entry may carry `keys` and `nets: [{name, nested_id, path, template?,
  count}]`. `added` and `mutated` carry `keys`; a produced entry carries
  them as its fifth element, its fourth then `null` for a token without a
  colour. Produced entries, `added` and `mutated` never carry `nets`.
- The reads take an address: `?path=` or `?nested_id=` on
  `GET .../execution/state`, `.../execution/history`, `.../tokens/{id}` and
  `.../places/{place}/tokens`, and `path` or `nested_id` in the body of
  `POST .../inject`. Both is 422 `invalid_params`; a net that is gone 404
  `unknown_net`. `POST .../query {filter?, token_limit?, path?, nested_id?}`
  and `GET .../distinct?key=&places=&path=&nested_id=` answer the protocol's
  results. `step`, `start`, `stop`, `reset`, `enable` and `disable` take no
  address: they act on the outer net.
- The worker stream carries `nested {path, nested_id, event: {method,
  params}, marking_version, running}` and `hidden {kind, place}` as kinds.
  The wrapper's version is the outer net's, which it does not move; the
  inner event carries the inner net's.

### Decisions

- **One view and a breadcrumb, not a side panel.** Opening a token's net
  (the **Open** control in the token inspector, or a double click on a
  badged token) swaps the graph panel to that net: its own layout, its own
  mirror, its own firing animation. Above the panel a breadcrumb names
  where it is (`transit > Depot/#17/cabin`) and **Up** goes back to the
  outer net, which was kept live underneath, so nothing is fetched. Chosen
  over the Bevy viewer's side panel and windows because the page has one
  canvas and two side bars already, and one net at a time keeps the
  inspectors, inject and the filter unambiguous about which net they mean.
  One level deep for now: a badged token inside an inner net shows its
  badge, and its inspector says deeper levels come later.
- **The controls stay outer-level.** Step, Repeat Step, start, stop, reset,
  enable and disable keep driving the outer net while an inner net is
  shown, as in the Bevy viewer; the protocol gives inner nets no switches
  of their own over the wire (§12.3). The transition inspector shows an
  inner transition's state without switches and says why. Inject is the
  exception: it is offered for the inner net's serializable places and goes
  in by the address.
- **Inner nets are named by `nested_id`**, never by path: a path changes
  every time the holding token moves (it gets a new id), a nested id does
  not.
- **The inner mirror is fed apart.** `nested` lines are not applied to the
  outer mirror and never count as a gap there. A line of the net shown is
  unwrapped and applied to the inner mirror under the inner net's own
  version rule (a gap or an inner `reloaded` re-reads the inner net). A line
  of any other net only moves the badge of the token holding that net: the
  badge is a hint (§12.3), moved by the line (`added` +1, `removed` −1,
  `launched` −consumed, `distributed` +produced, `fired` both, a restoring
  `failed` +consumed) without moving the outer version, and replaced by the
  next state read. A token a firing or an `added` puts into a nested place
  carries no `nets`, so the page re-reads the outer state (at most every two
  seconds) to badge it.
- **When the inner net goes.** An outer `removed` of the holding token, an
  outer `reloaded`, and a 404 `unknown_net` on a read of the inner net close
  it, and the panel falls back to the outer net with a one-line notice
  saying why. An outer firing that takes the holding token is not taken to
  mean the net is gone: the common move puts the token back with a new id
  and the net keeps its nested id (§12.6). The page asks after the net when
  that firing lands; the answer says where it is now (the breadcrumb
  follows) or, as `unknown_net`, that it was consumed (`Inner net gone: its
  token was consumed by Scrap.`). The holding token is known by its id,
  read from the latest path, since a token put back carries no `nets` until
  the next state read.
- **Outer firings seen from inside.** An inner `added`, `removed`,
  `mutated`, `param_changed` or `hidden` that is not one of the inner net's
  own firings is an outer firing reaching inside. Both firing shapes are
  read: Python writes the inner lines between `launched` and `distributed`,
  so a line with a firing under way is that firing's; the Rust runner's
  example binary reports a firing in one piece, the inner lines and its
  `mutated`s first and `fired` last, so a line with no firing under way
  waits (`TOUCH_CLAIM_MS`, 400 ms) for the next outer `launched` or `fired`
  to claim it. One no firing claims in that time, or that a landing, an
  `added`, a `removed` or a `toggled` overtakes, came from outside (an
  inject). The page names it above the panel for three seconds (`outer:
  Alight Central`, or `from outside: not an outer firing`).
- **Filtering is the view's own.** A filter bar above the graph offers the
  key names the shown net's places declare; picking a key lists its values
  (from `distinct` when the server answers it, else from the tokens the page
  holds), and values toggle on and off: OR within a key, AND across keys,
  compared by JSON type and value. A hidden token is not drawn (its slot
  stays empty, so the animation still finds the others), its cue does not
  travel, the token inspector lists only matching tokens and says how many
  it hides, each place reads `matching of count` (`2+ of 300` when the place
  holds more than the page lists), and a banner says `showing N of M
  tokens` with **Clear**. The execution log is not filtered. Nothing is
  sent to the server: the relay's projection (`POST .../filter`,
  `?client=`) is for a client that must not see the hidden tokens at all,
  and on this page a filter is a way of looking, not a permission; the view
  side also keeps every count exact. `queryNet` is in the client for a page
  that wants the matching tokens' data; this one does not call it.
- **Keys** show in the token inspector as rows, one per key.

### Tests

Vitest: `innerNets.test.ts` (the badge, routing by `nested_id`, the inner
version rule, closing, the holder by path, the breadcrumb, outer firings
seen from inside), `tokenFilter.test.ts`, and additions to
`netMirror.test.ts` (keys and nets kept, `hidden`, `nested` not applied),
`netView.test.ts` (badges, the filter's drawing), `firingPlayback.test.ts`
and `api.nets.test.ts` (addresses, `queryNet`, `distinctValues`). The
browser suite's `test_inner_nets_and_keys.py` descends by the inspector and
by a double click, steps the outer net while the inner net animates, falls
back when the token is consumed and when it is removed, and filters a keyed
net. The fake control plane (`tests/ui/fake_cp.py`) grew the addressed
routes, `query`, `distinct`, inner nets and the `nested` stream.

## Edges on empty places in the page (2026-10-14)

**Status:** Implemented 2026-10-14 on branch `drain-survey-edges`. Protocol
§5.1 (the `drain` and `survey` kinds) and §11 (the `shop` net). The design
is petritype-rs `dev-docs/EDGES_ON_EMPTY_PLACES.md`, whose R7 and D5 the
Bevy viewer built the same day. On 2026-10-16 the protocol split the shop's
example in two (§11): the `shop` keeps only the survey (`Day End`,
`Expired` and `Close Day` are gone), and a new conformance net,
`traffic-light`, has the drain beside a plain `snapshot`. The page's code
did not change; the tests below follow the two nets. Later the same day
the traffic light became one place (§11, `08_traffic_light.json` recorded
again): the light, three places `Red`, `Green` and `Amber`, is one place
`Light` whose one token is its colour, and `Change` moves the colour on,
taking from `Light` and writing back to it. And later still it became two
transitions (§11, `08_traffic_light.json` recorded again): `Go`, guarded
on green and someone waiting, drains `Waiting` and reads `Light` through a
plain `snapshot`; `Change`, unguarded, cycles the light. Guards are not on
the wire and the edge kinds are the same, so the page's code did not
change either time. `Change`'s loop through `Light` is a cycle the layout
breaks as any other, one edge of it drawn curved. (On 2026-10-16 the light
went from three places to one place, and then to two transitions.)

### What the wire gives the page

An input edge's `kind` may now be `drain` or `survey`. Both read every token
of their place, zero or more, and never hold the transition back: a drain
takes the tokens, and a survey hands the body a copy of them. A drain's
`consumed` may list nothing from its place. Nothing else on the wire
changes. The page reads `fireable` rather than judging it, so only the
types and the drawing change.

### Decisions

- **The stroke of the nearest old kind.** A survey is a read edge and is
  drawn dashed, as `snapshot` is. A drain consumes and is drawn solid, as
  `take_all` is. The Bevy viewer colours a read edge, but this page draws
  every input edge in one colour and tells read edges apart by their
  dashes, so the dash is how the page says "read" (`edgeStroke` in
  `netView.ts`).
- **A hollow arrowhead** (D5) marks an input edge whose kind accepts an
  empty place. It is chosen apart from the stroke, by `edgeHead` beside
  `edgeStroke`, and drawn with the marker `arrowhead-input-hollow` beside
  the others in `GraphPanel.svelte`. Its outline is the input edge's colour.
  Its inside is the graph's background (`--graph-bg`), not left empty: an
  SVG marker sits over the end of its line, so an empty head would show the
  line running through it to the tip. The Bevy viewer avoids that by
  stopping the line at the head's base. Here, filling with the background
  hides the line without changing the edge's geometry, and both themes
  define `--graph-bg`. The outline is inset by half its stroke, so its tip
  sits where a filled head's tip does. Markers do not inherit the edge's
  dashes, so a dashed survey still has a whole head.
- **The inspector names what they do.** The transition inspector's input
  rows give the two kinds a phrase: `drain: takes every token, zero or
  more` and `survey: copies every token, zero or more`. The other kinds go
  by their names, as before. The page has no legend and no edge tooltips,
  so that row is the one place where it lists kinds. It shows when the
  transition carries no `detail`.
- **`mutate_where` is dotted now**, as `mutate` is. It is a mutate edge with
  a filter, so it is a read edge too. Until this slice it was drawn solid,
  because the stroke rule only knew `mutate`. `take_where` stays solid, as a
  take does.
- A kind the page does not know still draws as a plain edge, solid with a
  filled head.

### Tests

Vitest, in `netView.test.ts`:
- the stroke and the head of each of the eight kinds, `mutate_where`
  dotted;
- an unknown kind, and an edge with no kind, drawn plain;
- an output edge never hollow;
- the shop drawn through `drawNet`: the survey dashed with a hollow head;
- the traffic light drawn through `drawNet`: the drain solid with a hollow
  head, the plain read (`snapshot`) dashed with a filled one, both `Go`'s,
  and of `Change`'s loop through `Light` one edge, the write back, a back
  edge;
- the inspector's two phrases, the survey's on the shop's `Price Order`
  and the drain's on the traffic light's `Go`, the snapshot named by its
  kind beside it, and `Light` both input and output of `Change`.

The fake control plane's firing rule (`tests/ui/fake_cp.py`) now knows the
two kinds. A survey edge takes nothing and does not hold its transition
back, and its place's tokens are handed over as copies. A drain edge takes
every token of its place, zero or more, and does not hold its transition
back either. `bodies` lets a test give a transition a body of its own,
from what each input handed over to the tokens it produces. Since
2026-10-16 a snapshot's place must hold a token, as both runners require;
until then the fake did not ask. Since the light became one place, a
transition may carry a guard (`net_state(guards=...)`), a function of the
marking's places, which must hold for it to be fireable: `Go`'s drain
never holds it back and `Light`, which it reads, is never empty, so
presence alone would let it fire at every colour; its guard reads the
colour in `Light` and the count of `Waiting`, as the runners' guards do. A
guard stays out of what the fake serves, as a runner's stays off the wire.

The browser suite's
`test_net_protocol.py::test_the_shop_draws_its_survey_and_prices_orders`
seeds the shop's topology, empty as §11 seeds it, and gives `Price Order`
the shop's body. It checks:
- each edge's stroke, head and `marker-end`;
- the hollow head's fill against the graph's background, and its outline
  against the filled input head;
- the inspector's row for `Price Order`, the survey's phrase.

It then drives the script of transcript `07_empty_place_edges.json`, with
the fake's `inject` and the page's **Step**:
- An order alone makes `Price Order` fireable, though `Promotions` is
  empty. It fires: the log reads `Orders #1 → Priced #2`, and nothing
  goes into `Discounts Applied`.
- Two promotions make nothing fireable. A second order is priced with both:
  the log lists only the order as consumed, `Promotions` keeps its two
  tokens, and the token inspector shows the two discounts, oldest first.
  With no order left, `Price Order` is idle again.

`test_net_protocol.py::test_the_traffic_light_draws_its_drain_and_its_read_and_lets_the_cars_go`
seeds the traffic light as §11 seeds it, `"red"` in `Light` as token 0, as
the Rust runner numbers it, with `Go`'s guard (green and someone waiting)
and the two bodies (`Go`: every car drained into `Passed`; `Change`: the
next colour into `Light`). It checks each edge's stroke, head and
`marker-end`, the drain solid and hollow and the snapshot dashed with the
filled input head, one back edge for `Change`'s loop through `Light`, and
the inspector's rows for `Go` (the drain's phrase, then `snapshot`) and
`Change` (a plain `Light`). It then drives the script of transcript
`08_traffic_light.json`, checking which transitions look fireable and
which idle after every step and arrival:
- `Change` alone is fireable, `Go` held by its guard. `Change` turns the
  light green, `Light #0 → Light #1`, where with nobody waiting `Go` is
  still idle, and amber, `Light #1 → Light #2`.
- Two cars arrive at amber: only `Change` is fireable. It turns the light
  red, `Light #2 → Light #5`, the cars still waiting, and green, `Light #5
  → Light #6`, where `Go` and `Change` are both fireable.
- `Go`, declared first, drains both: `Waiting #3, Waiting #4 → Passed #7,
  Passed #8`, the light only read, and `Change` alone is fireable.
- A third car arrives at green: `Go` and `Change` are fireable, and `Go`
  fires, `Waiting #9 → Passed #10`, the light staying in `Light` as token
  6. `Change` fires, `Light #6 → Light #11`.
- The token inspector shows the three cars in `Passed` and `amber` in
  `Light`, and `Change` is fireable: the light never stops.
