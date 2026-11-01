# Frontend and control plane communication

How the browser talks to the petritype-server control plane (CP). The server
side lives in `../petritype-server`; this file records what the frontend
relies on.

## Authentication

- The browser authenticates with an httponly session cookie
  (`petritype_session`). Every call in `src/lib/api.ts` sends
  `credentials: 'include'`, and every EventSource opens with
  `withCredentials: true`. The `(app)` layout redirects to `/login` when
  `getMe()` returns no user; the build trigger turns a 401 into
  `SessionExpiredError`.
- Personal API tokens (`petri_pat_...`) are for scripts and agents, never the
  browser. The Settings page creates, lists and revokes them; token
  management itself needs a browser session, as do shares (below). Each
  token has a scope, checked by the server in
  `petritype_server/auth/scopes.py`:
  - `read`: GET requests only.
  - `operate`: every other write, such as load, start, stop, reset, inject,
    and creating or editing nets and notebooks.
  - `manage`: everything, including every DELETE, `POST /api/workers`, worker
    provision and destroy, `POST /api/github/repos` and repo build triggers.

## Requests

- `API_URL` comes from `PUBLIC_API_URL` (`src/lib/config/network.ts`); it
  defaults to `http://localhost:8000` in dev and must be https in production.
- Every one-shot request goes through `_timed` in `api.ts`, which reads the
  CP's `Server-Timing` and `X-Backend-Slow: db` headers and feeds
  `stores/backendHealth.ts` (names 429 as rate limited, throws and 502/503/504
  as unreachable) and `stores/slowRequests.ts` (the "still working" toast).
- Identical concurrent reads are coalesced. State-changing calls that may be
  retried carry an `X-Idempotency-Key` (`idempotency.ts`).
- The CP rate-limits the nets and workers lists (30/min), the wiring view
  (60/min) and the auth routes per user; a 429 shows as a banner.

## Net execution proxy

Execution state, history, step, start, stop, reset, inject, tokens, enable,
disable, press, query and distinct go to `/api/nets/{id}/...` and the CP
forwards them to the net's worker. Since 2026-10-04 bodies and answers are the net
protocol's, version 1 (`PROTOCOL.md` in the petritype library); the shapes
live in `src/lib/types.ts`:

| Call | Answer |
|---|---|
| `GET .../execution/state?token_limit=` | The protocol state: `topology.{places, transitions, edges, hints?, controls?}`, `transitions[name].{enabled, fireable, in_flight, priority?}`, `marking.places[name].{count, tokens}` (the page reads sizes from `count`; `tokens` is capped at `token_limit`, 200), `generation`, `marking_version`, `running`, `runtime`, `progress`. |
| `GET .../execution/history?after=&limit=` | `{entries}`, oldest first, each `{seq, transition, started_at, duration_ms, outcome, consumed, produced}` with consumed and produced as `[place, id]` pairs. The page reads it whole on a resync and `after` its newest `seq` once a firing lands. |
| `GET .../tokens/{id}` | `{id, place, type_name, kind: "json", value}`, or `kind: "text"` with `text` for a place with no JSON form; `keys` and `nets` when the token has them. |
| `POST .../inject {place, token}` | `{status, id, marking_version}`; watchers see `added`. The page offers only places with `serializable: true`. |
| `POST .../query {filter?, token_limit?, path?, nested_id?}` | `{marking_version, count, matches: [{place, token, json?}]}` (`queryNet`; the page itself does not call it). |
| `GET .../distinct?key=&places=&places=&path=&nested_id=` | `{marking_version, key, values}` (`distinctValues`); the filter bar's values for a key, falling back on the tokens the page holds when the route refuses. |
| `POST .../execution/step` | `{fired, transition?, failed?, marking_version, running}` once the firing has landed. |
| `POST .../transitions/{name}/enable\|disable` | `{marking_version}`; watchers see `toggled` if it changed. |
| `POST .../press {control, value?}` | `{status: "pressed" \| "nothing", reason?, marking_version}`, once a press that fires has landed; watchers see the events of what it did. `value` is left out for a button. |

Since 2026-10-12 the reads take an inner net's address (protocol §12.3):
`?nested_id=` or `?path=` on `GET .../execution/state`,
`.../execution/history`, `.../tokens/{id}` and `.../places/{place}/tokens`,
and `nested_id` or `path` in the body of `POST .../inject`, whose answer then
carries the inner net's `path`, `nested_id` and its own `marking_version`.
The page names inner nets by `nested_id` only. Both is 422
`invalid_params`; an inner net that is gone is 404 `unknown_net`, which
closes the page's view of it. `step`, `start`, `stop`, `reset`, `enable` and
`disable` take no address. A state may carry `topology.places[].nested`,
`passive` and `key_names`, and a token `keys` and `nets` (§5.3). The
relay's per-client projection (`POST .../filter`, `?client=`) is not used by
the page: its token filter is its own.

An input edge's `topology.edges[].kind` is `take`, `take_all`, `snapshot`,
`mutate`, `take_where` or `mutate_where`, and since 2026-10-14 `drain` or
`survey` (protocol §5.1): these two read every token of their place, zero or
more, a drain taking them and a survey copying them, and never hold the
transition back. The page never judges fireability itself, it reads
`fireable`, so nothing else changed. It draws `snapshot` and `survey`
dashed, `mutate` and `mutate_where` (a mutate edge with a filter) dotted and
the rest solid, `drain` and `survey` with a hollow arrowhead, and a kind it
does not know as a plain edge.

Since 2026-10-16 a state may carry `topology.controls`, the controls the
net declares (`{name, label, kind, node?, action?, config?}`, protocol
§5.1), and a place `style: {fill: "token"}`. The page keeps both in its
mirror, draws the controls as the legend over the graph and presses them
with `POST .../press` (`executionPress`, §6.6), and fills a styled place
with its one token's `color`. Controls belong to the outer net, so a press
takes no address.

Every refusal arrives as `{"detail": <sentence>, "reason": <tag>}`, parsed
into `NetProxyError` (`status`, `reason`, message = detail). The CP refuses on
its own with 404 `net_not_found`, 409 `not_assigned`, 503 `worker_not_ready`
and 502 `worker_unreachable`, and the page shows the detail. Protocol errors
carry the protocol's code (`isProtocolError()`): 404
`unknown_net|unknown_place|unknown_transition|unknown_token|unknown_control`, 422
`invalid_params|invalid_token|not_serializable|load_failed`, 501
`unsupported|unknown_method`, 409 `not_loaded`, 500 `internal`. A 409
`not_loaded` makes `isNotLoaded()` true: shown quietly as a state, and reads
return empty (history, log history). A step outlasting 15 s answers 504
`timeout` (`isStillInProgress()`); the page treats it as in progress, since
the firing lands on the stream, and does not report the 504 as the backend
being unreachable.

`isNotLoaded` also accepts a bare 404 with no reason, from an older CP.
`diagnoseNet` (`GET /api/nets/{id}/diagnose`) returns one verdict per net,
judged against its own stall threshold; `netDiagnose.ts` colours it.
State `waiting` (a 24/7 net with no stall threshold, running but with nothing
enabled) is quiet like `scheduled`. `facts.worker_probe` may carry
`executing_since`, `executing_transition` and `idle_since`, with
`facts.executing_age_seconds`, `idle_age_seconds`, `stall_threshold_seconds`
and `stall_threshold_source` (`declared` or `default`); all nullable, and the
panel turns the first set into one line under the reason.

## Live channels

All are Server-Sent Events with the cookie; there is no WebSocket in this app
apart from the one Marimo opens inside the notebook iframe.

- `GET /api/events` (`stores/serverEvents.ts`): per-user CP events, fed by
  Postgres LISTEN/NOTIFY so they are sent only after the writing transaction
  commits. Each carries a monotonic `seq` (also the SSE id); on reconnect the
  store replays `GET /api/events/history?after={seq}`. Types:
  `worker_state_changed`, `net_state_changed`, `notebook_state_changed`,
  `notebook_error`, `net_load_log`, `worker_provision_log`,
  `net_run_started|finished|skipped`, `operation_started|progress|finished`.
- `GET /api/workers/{id}/events?after={seq}`: the worker's unified stream,
  `{seq, scope, net_id, kind, ts, data, marking_version, running}`. A net's
  kinds are the protocol notification methods with `data` their params:
  `launched`, `distributed`, `fired`, `failed`, `added`, `removed`,
  `mutated`, `hidden`, `toggled`, `param_changed` (each moves
  `marking_version` by exactly one and carries it in `data`), `reloaded`
  (refetch), `fireable`, `idle`, `execution_stopped {reason:
  no_fireable_transitions | transition_failed | subprocess_exited,
  error_type?, message?}`, `heartbeat`, `load_progress`, and, since
  2026-10-12, `nested {path, nested_id, event: {method, params}}`, an inner
  net's notification whole inside `event` with the inner net's own version,
  the envelope's and the wrapper's version the outer net's, which it does
  not move. `hidden {kind, place}` reaches only a client under the relay's
  projection, which this page never sets. Plus the host's own
  `subprocess_output`, `memory_stats` (every 5 s), `log` and `stream_gap`. `transition_fired`,
  `step_*`, `graph_state` and `net_reset` are gone. The envelope's
  `marking_version` is the worker's latest on every net event, log lines
  included; the page's version rule reads the one in `data`. `after=0` replays the whole
  buffer, about 2000 events and 6 MB for a busy worker. A connection that
  wants only a live tail asks with `after=1000000000000`, a cursor ahead of
  any worker sequence, as the CP's own keepalive does: the worker replays
  nothing and sends one `stream_gap` marker (`reason: restarted`,
  `data.current_seq` its sequence now) that seeds the cursor. Reconnects a
  store makes itself ask with `after={seq}` so the worker replays what was
  missed. Three pages open it:
  - The nets page (`stores/workerEvents.ts`) opens a live tail for the
    selected net's worker. It fetches the net over REST on selection, and
    replaying the buffer on top of that froze the tab. The stream is a fast
    path, not the truth: the page keeps a marking mirror (`netMirror.ts`)
    and applies a state notification only at its held `marking_version`
    plus one, ignoring older ones; a gap, a `reloaded`, a name it does not
    know, or a place whose drawn tokens fell short of its count refetches
    the state. `workerStream.ts` also bumps a generation on reconnect, on a
    `stream_gap` that answers a real cursor, or on a restarted sequence,
    and the page refetches over REST. A new protocol `generation` drops
    every token, animation and cached token view. Firings are animated from
    the events (`firingPlayback.ts`): stage one on `launched`, stage two on
    `distributed` once stage one is over, and a one-piece `fired` plays both
    in turn. A `nested` line moves the badge of the token holding its net
    and, while the page shows that net, is applied to the inner net's own
    mirror (`innerNets.ts`); the page reads that net with
    `GET .../execution/state?nested_id=` when it opens it, on an inner gap,
    and when an outer firing that took its token lands.
  - The workers page (`connectRuntimeLogs(id, { replay: false })` in
    `stores/workerLogs.ts`) opens a live tail for every ready worker, for
    new log lines and the `memory_stats` frames its gauges read. Until a
    worker's first frame, its gauge shows `memory_used_mb` from
    `GET /api/workers`, which is the worker server process alone (the
    health loop reads it from the process itself), labelled as such and
    without a per-net breakdown (`workerGauge.ts`).
  - The full-page log viewer at `/workers/{id}/logs`
    (`connectRuntimeLogs(id, { replay: true })`) asks with `after=0`: the
    buffer is the only record of the worker's runtime log. Its lines reach
    the store in batches (`batchScheduler.ts`).
- `GET /api/workers/{id}/logs/history` seeds the worker log viewer;
  `GET /api/nets/{id}/logs/history` (`getNetLogHistory`, with `limit`,
  `since`, `contains`, `newest_first`) reads the worker's durable per-net
  log file, which survives subprocess and worker restarts.
- `GET /api/notebooks/{id}/events` streams notebook load progress
  (`notebookLoadProgress.ts`).

## Notebooks

The notebook page embeds `/api/notebooks/{id}/` in an iframe; the CP proxies
it to Marimo on the worker, and Marimo's render WebSocket runs inside the
iframe. Health rides HTTP: the page polls `GET /api/notebooks/{id}/sync`
(bridge slot reports, transport counters) and judges it with thresholds the
CP serves (`notebookThresholds.ts`). The page cannot see the cross-origin
iframe's socket, so `notebookSync.ts` decides from ages and counters whether
to remount the iframe, with a capped budget.

## Shares

A share opens a world of the owner's nets, or one notebook, to people outside
the account. Viewers reach it through the public tier, a separate Fly app
with its own origin; the owner mints, lists and revokes shares over three CP
routes (`listShares`, `createShare` and `revokeShare` in `api.ts`), and
keeps the handles public shares are served under over four more
(`listPublicHandles`, `reservePublicHandle`, `renamePublicHandle` and
`releasePublicHandle`, "Public shares and their handles" below). The design
is `dev-docs/SHARING.md` in the petritype-server repository.

| Call | Answer |
|---|---|
| `GET /api/shares?net_id=` | The owner's shares, newest first, revoked and expired ones included, each with its `nets`. `net_id` (optional) narrows the list to the world shares holding that net; a malformed one is 422. |
| `POST /api/shares` | 201 with the share and its `token`, the only time the secret is shown. |
| `DELETE /api/shares/{id}` | `{status: "revoked"}`. The row stays listed with `revoked_at` set; revoking twice is fine; another owner's share is 404 `Share not found`. |
| `GET /api/public-handles` | `{handles, limit}`: the owner's handles, oldest first, and how many the account may hold. |
| `POST /api/public-handles` | Body `{handle}`. 201 with the reserved handle, or a refusal below. |
| `PUT /api/public-handles/{handle}` | Body `{handle}`, the new name. 200 with the renamed handle, or a refusal below. |
| `DELETE /api/public-handles/{handle}` | 204 with no body, or a refusal below. |

All seven need the browser session: a request carrying a personal API token
is refused with 403 `This action needs a browser session, not an API token`,
so a leaked script token cannot open the owner's nets to anyone.

The mint body (`ShareRequest`); a field left out takes the default shown:

- `label`: 1 to 100 characters after trimming.
- `resource_kind`: `world` or `notebook`. A world names `nets`, 1 to 50 of
  the owner's nets, all on one worker when it is minted: a net on another
  worker, or on none, is refused. A notebook names `notebook_id`, one of the
  owner's notebooks, and is read only.
- `nets`: `[{net_id, play_places?, play_controls?}]`. The two lists are the
  places a play share may inject into and the controls it may press on that
  net, at most 100 names each, 1 to 200 characters a name; the server trims
  them and drops repeats.
- `scope`: `read` (default) or `play`. A read share takes no seat, places or
  controls. A play share needs a `seat`, 1 to 100 characters, the name
  stamped on its player's inputs, and at least one place or control on one of
  its nets.
- `audience`: `link` (default), anyone holding the link; `named`, which
  needs a `member_email`; or `public`, anyone, at `/p/<handle>/<slug>`,
  which needs a `handle`, a `slug` and scope `read`. Only a named share
  takes a `member_email`.
- `handle`: the handle a public share is minted under, one the owner has
  reserved, and only on a public share ("Public shares and their handles"
  below).
- `slug`: a public share's slug, the last part of its address, and only on a
  public share.
- `expires_in_days`: 1 to 365, counted from the mint; default 30, and 365 on
  a public share, since its address is meant to last.
- `publish_payloads`: default false, which strips token values and log lines
  from what viewers see; counts and firings still show.
- `max_viewers`: 1 to 200, default 20. `inputs_per_minute`: 1 to 600, default
  60, per seat across the world's nets.
- `bundle_id`: one of the owner's bundles ("Bundles" below), served beside a
  world share of either scope, since a read share can carry a viewer that
  only reads. Left out, the share names none. A notebook share takes none
  (`A notebook share takes no bundle: a bundle shows or plays a world of
  nets`), and another owner's bundle is refused (`Bundle <id> is not one of
  your bundles`).

A refused mint is 422 with one plain-English sentence in `detail`, which
`createShare` throws as it stands. A body that does not parse (an unknown
field, a value of the wrong type) is FastAPI's own 422, a list of complaints;
`createShare` throws the first, prefixed with the field it names. The server
refuses a setting the share would never read rather than storing it, so a
caller sends `seat` and the per-net lists only on a play share,
`member_email` only on a named one, `handle` and `slug` only on a public
one and `bundle_id` only on a world. An owner holds at most 100 active shares
(the next is refused with `You already have 100 active shares; revoke one
first`) and mints at most 10 a minute (429, which `createShare` words as
such).

The share answer: `id`, `label`, `resource_kind` (`world` or `notebook`),
`notebook_id` and `notebook_name` (its notebook's id and name, both set
exactly on a notebook share and null on a world), `scope` (`read` or
`play`), `audience` (`link`, `named` or `public`), `member_email` (set
exactly on a named share), `seat` (set exactly on a play share), `handle`,
`slug` and `public_path` (set exactly on a public share and null otherwise:
the handle it was minted under, which it keeps after that handle is renamed
or released, its slug, and the path `/p/<handle>/<slug>` built from the
two), `prefix` (the 8 characters after `petri_share_`),
`publish_payloads`, `max_viewers`,
`inputs_per_minute`, `created_at`, `expires_at`, `revoked_at`,
`last_used_at` (written by the public tier at most once a minute),
`bundle_id` and `bundle_label` (the bundle a world serves, both null when it
names none and once that bundle is deleted), and `nets`, each `{net_id,
definition_name, instance_name, worker_id, play_places, play_controls}`. A
net's `worker_id` and names are read from the net on every answer, so they
follow a rename or reassignment made after the mint, and a world a
reassignment split shows nets on more than one worker. A deleted net leaves
its worlds; a deleted notebook deletes its shares. The `token` is
`petri_share_` followed by 43 url-safe characters.

The Sharing page (`/sharing`) lists every share and mints and revokes them. It names a
world share's nets by their own `instance_name`, a notebook share's notebook
by its `notebook_name`, and shows the `bundle_label` of a share that serves a
bundle, all from the share itself. Only the mint form's pickers read `GET
/api/wiring`, which carries every net with its `worker_id`, assigned or not,
and every notebook. The net picker groups nets by worker and, once a net is
picked, leaves only nets on that worker selectable; a net on no worker is
never selectable. Otherwise it sends what the owner typed and shows the
server's sentence: an emptied number is left out so the default applies, and
the place and control lists are split on commas and trimmed. The link for a
share is `${PUBLIC_SHARE_URL}/s/${token}`, with `PUBLIC_SHARE_URL` the public
tier's base URL, no trailing slash, read at runtime like `PUBLIC_API_URL`
(`fly.toml` sets `https://petrify-public.fly.dev`). The page shows it once,
after the mint. When the value is empty, or is not an http(s) URL (https in
production), it shows the token itself with a note that the public tier's
address is not configured.

### Public shares and their handles

A public share is for something meant to be found, such as a status board:
it is read only and served at an address that reads well and survives a
re-mint, `${PUBLIC_SHARE_URL}${public_path}`, where `public_path` is
`/p/<handle>/<slug>`. The address is not a secret. The mint answer still
carries a `token` for a public share, and `/s/<token>` reaches it too, but
the page shows the address and never the token.

A handle is a publishing space: an account reserves several ahead of any
share, up to its limit, and mints each public share under one of them. A
handle is 3 to 30 characters of lowercase letters, digits and single
hyphens, neither first nor last (`^[a-z0-9]+(-[a-z0-9]+)*$`), none of `api`,
`s`, `p`, `health`, `admin`, `static`, `assets`, `www`, `petrify`,
`petritype`, `share`, `shares`, `sharing`, `public`, `login`, `logout`,
`docs`, `help`, `about`, and unique across every account. The handle answer
is `{handle, reserved_at, last_used_at, live_shares}`: `last_used_at` is set
by each public mint under it, null until the first, and `live_shares`
counts the unrevoked public shares under it, expired ones included. A
handle is in use while `live_shares` is above 0. A reservation never
expires; the limit, 3 unless the account has an override, is what keeps it
small.

Each refusal is one sentence in `detail`, which the handle calls throw as
it stands:

- Reserving (`reservePublicHandle`): a malformed handle or a reserved word
  with 422; one any account holds with 409 `That handle is taken; choose
  another`; and an account at its limit with 422 `You already hold N
  handles; release one first`.
- Renaming (`renamePublicHandle`): a handle that is not the owner's with
  404; one in use with 409 `Revoke the N public shares under <handle>
  first`, since renaming would move every live address under it; and a new
  name refused as reserving refuses it, save the limit. Renaming to the same
  name answers 200 and changes nothing.
- Releasing (`releasePublicHandle`): a handle that is not the owner's with
  404, and one in use with the same 409, since another account could then
  publish at its live addresses. A released handle is free for anyone, and
  a new holder could publish at addresses the owner once used under it.

Reserving and renaming are limited to 10 a minute, as minting is (429,
which the calls word as such).

A slug keeps the handle's pattern and is 1 to 60 characters. An address is
held per handle: a slug is unique among the unrevoked public shares under
that handle, expired ones included, so `oleg/boards` and `tailarm/boards`
can both be live. The mint of a public share refuses, with 422 and one
sentence: a handle the owner has not reserved (`Reserve the handle first`),
an address an unrevoked public share holds (`Your public share <label> is
already at /p/<handle>/<slug>; revoke it first`), a malformed slug, and
scope `play`; it refuses a `handle` or `slug` on a share of another
audience too. Revoking the holder frees the address, and a new share minted
at it takes the address over, which is how a board moves to a new notebook
without its address changing.

On the Sharing page a Public handles box above the share form lists the
owner's handles with each one's live shares and `2 of 3 handles reserved`
from the list's `limit`, and reserves another from a field whose Reserve
waits, with a note, once the account is at its limit. A handle not in use
offers Rename, an inline edit with Save and Cancel, and Release, which asks
first with the warning above (`releaseWarning` in `shares.ts`); a handle in
use shows `revoke its N public shares first` in their place. A refusal shows
in the row or under the field it came from, and the page reads the list
again, so a count made stale by another tab catches up. Minting or revoking
a public share reads the list again too.

The audience fieldset offers `public` beside `link` and `named`. Choosing it
sets the scope to read and disables play, moves an expiry still at 30 days
to 365 (the field's placeholder and note follow the audience), and shows the
handle, a slug field and the address previewed beneath them. With two
handles or more the handle is a select, defaulting to the one with the
latest `last_used_at`, compared as instants, else the oldest
(`defaultHandle` in `shares.ts`); with one it is named without a select. A
`new handle…` entry, in the select or beside the one handle, shows a field
that reserves a handle on the spot and chooses it, while the account has
room; with no handle the form shows that field at once. The mint button
waits until a handle is reserved and chosen. The slug is suggested from the
label (`slugFromLabel` in `shares.ts`: lowercased, each run of characters
outside a to z and 0 to 9 one hyphen, hyphens trimmed from both ends, cut to
60 characters and trimmed again) until the owner edits it, and is sent as
typed. The created panel shows a public share's address with Copy. The list
shows each public share's address in full with Copy beside it, where other
shares show their prefix, and offers Revoke on an expired public share as
well as an active one, since an expired share still holds its address until
it is revoked. Without a usable `PUBLIC_SHARE_URL` the page shows
`public_path` alone.

### Bundles

A bundle is a zip of static files, such as a game or viewer compiled to
WebAssembly, that the public tier serves beside a world share naming it, at
`/s/{token}/bundle/`. A bundle never changes: a new upload is a new bundle.
The owner uploads, lists and deletes bundles over three CP routes
(`uploadBundle`, `listBundles` and `deleteBundle` in `api.ts`; the design is
"Bundles as built" in `dev-docs/SHARING.md`). Like the share routes they need
the browser session, and refuse a personal API token with 403.

| Call | Answer |
|---|---|
| `POST /api/bundles?label=` | Uploads the zip, sent as the raw request body. 201 with the bundle. |
| `GET /api/bundles` | The owner's bundles, newest first. |
| `DELETE /api/bundles/{id}` | `{status: "deleted"}`; another owner's bundle is 404 `Bundle not found`. Each share that named it carries on without one, its `bundle_id` and `bundle_label` null. |

The bundle answer: `id`, `label`, `size_bytes` (its files' total,
uncompressed), `file_count`, `content_hash` (the SHA-256 of the zip as
uploaded) and `created_at`.

The upload's body is the zip file itself, not a form, with `Content-Type:
application/zip` (the server also takes `application/octet-stream`), and the
label is the `label` query parameter. A cross-site page may send a form or
plain-text body with the owner's cookie without asking the browser first;
these two content types make the browser ask, and the CP's CORS list answers
only the frontend's origin. Each refusal is one plain-English sentence in
`detail`, which `uploadBundle` throws as it stands:

- 413 `A bundle's zip is at most 64 MiB.` for a larger body; a declared
  length above the cap is refused unread. The server can send that answer
  before the browser has sent the whole body, and a browser may then report
  the upload as `Failed to fetch` instead, so the page checks the file's size
  first (below).
- 415 `Send the zip as the raw request body, with Content-Type
  application/zip.` for any other content type.
- 422 `A bundle's label must be 1 to 100 characters`, counted after trimming.
- 422 for a zip the server's check refuses, naming the first problem: not a
  zip (`The upload is not a zip file.`); no `index.html` at its root (`There
  is no index.html at the root of the zip. Zip the contents of the bundle's
  folder rather than the folder itself, so that index.html is at the top.`);
  more than 2000 files; over 256 MiB uncompressed; an entry that is
  encrypted, damaged or a symbolic link; a path that is absolute, holds `..`,
  a backslash or a NUL, has an empty name or one starting with a dot, or is
  over 512 bytes; an extension outside the allow list in
  `dev-docs/SHARING.md`; a path twice.
- 422 `You already have 20 bundles; delete one first`.
- 429 past 5 uploads a minute, which `uploadBundle` words as such.

The Sharing page's Bundles section lists the owner's bundles (label, size
uncompressed in MB to one decimal, file count, upload date) with Delete
behind an inline confirm, and uploads a zip under a label: the Upload button
waits for a file, a file over 64 MiB is refused in the page with the
server's 413 sentence and no request (`bundleFileRefusal` in `shares.ts`),
the page shows a busy line while the upload runs, the server's sentence on a
refusal, and the new bundle at the head of the list on success. After a
delete it lists the shares again, so a share that named the bundle shows
none. The mint form's Bundle select, shown for a world of either scope and
hidden for a notebook, offers the owner's bundles by label with none as the
default; the mint carries `bundle_id` only when a world picks one.

### Artifacts

An artifact is the latest bytes a net or notebook published under one name,
such as a plot as PNG or SVG, a JSON document, a CSV table or an HTML page.
The control plane keeps them and serves them to the owner over two routes
(the design is "Artifacts as built" in `dev-docs/SHARING.md`). No page shows
them yet. These routes take a personal API token of read scope as well as
the browser session.

| Call | Answer |
|---|---|
| `GET /api/artifacts?net_id=` or `?notebook_id=` | One of the owner's nets' or notebooks' artifacts by name, without their bytes: each `{id, net_id, notebook_id, name, content_type, size_bytes, content_hash, updated_at}`. Naming both or neither is 422 `Name exactly one of net_id and notebook_id.` |
| `GET /api/artifacts/{artifact_id}` | The bytes with their content type and an `ETag`, 304 on a matching `If-None-Match`, under a sandboxing `Content-Security-Policy` that allows no script and no requests. Another owner's artifact is 404. |

The rule for whoever builds the page that shows them: an HTML or SVG
artifact is rendered only inside an `<img>` or a sandboxed `<iframe>` whose
`src` is the control plane's URL for it (`${API_URL}/api/artifacts/{id}`),
where the control plane's policy applies, and never through a blob URL or
`{@html}`. Its bytes are whatever a net's code published, and rendered on
the frontend's origin they would run with the owner's session.

## Polling

SSE triggers refetches; a few pages also poll as a fallback: the workers page
every 30 s while visible, the notebooks index `/sync` every 10 s, and the nets
page every 5 s while a net is running.

## State the UI assumes

- Worker `status`: `pending`, `provisioning`, `ready`, `stopped`, `error`.
  Net actions need `ready`. When a worker leaves `ready`, the CP resets its
  nets to `unloaded` and emits the events.
- Net `load_state`: `unloaded`, `loaded`, `error`, with the reason in
  `load_error`. Notebook `load_state` works the same way, and
  `notebookLoadReason.ts` turns `load_error` codes (idle eviction, crash,
  teardown) into words.
- Deleting a worker deletes its nets and secrets; its notebooks become
  unassigned with reason `worker_deleted` (`workerDelete.ts`).
- The CP runs its own health loop over ready workers, so a dead machine
  reaches the UI as a `worker_state_changed` event.
