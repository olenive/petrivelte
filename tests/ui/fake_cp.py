"""A fake control plane for driving the real frontend in a browser.

It answers the REST calls the nets page makes with fixed data, and holds the
two event streams the page listens on open: the control plane's own
(`GET /api/events`) and the per-worker one (`GET /api/workers/{id}/events`).
A test pushes frames onto either stream with `publish_server` and
`publish_worker`, and `drop_worker_streams` closes the worker streams so the
browser reconnects.

The worker stream answers its `after` cursor the way the worker does
(`_catch_up_messages` in the server's `worker/server.py`): `0` replays the
whole buffer, a cursor inside the buffer replays only what follows it, and a
cursor ahead of the worker's sequence gets one `stream_gap` marker saying
where the sequence is now, with nothing replayed. Every worker stream request
and what it was answered with is kept in `worker_stream_answers`. All workers
share one buffer and one sequence; `publish_worker` with a `worker_id` sends
the live frame only to that worker's streams.

The net execution proxy speaks the net protocol, version 1 (PROTOCOL.md in
the petritype library): `GET .../execution/state?token_limit=` answers the
protocol's state, `.../execution/history?after=&limit=` its log as
`{entries}`, `POST .../execution/step` the step result once the firing has
landed (or `504 {reason: "timeout"}` for a step a test made slow), and
`inject`, `reset` and `transitions/{name}/enable|disable` their results.
Each of these moves the fake net the way a runner would and publishes what a
runner notifies on the worker stream, stamped with the marking version: a
firing is `launched` then `distributed`, an inject is `added`, a reset is
`reloaded`, a switch is `toggled`, and `fireable` follows a changed fireable
set. Refusals carry `{detail, reason}` with the protocol's code. A test can
also move the net without the page asking, with `fire`, `inject` and
`reset`.

A firing takes the front token of each input place except a read edge's
(`snapshot`, `mutate`, `survey`), and from a `drain` edge every token, zero
or more (§5.1). It needs a token in every input place except a drain's and
a survey's, which never hold a transition back; a snapshot's place must
hold one to be read, as both runners require (since 2026-10-16; until then
a snapshot was not asked). A transition may also carry a guard, given to
`net_state` as `guards`: a function of the marking's places that must hold
for it to be fireable, as the traffic light's `Go` is guarded on the
colour in `Light` and on someone waiting. A guard is not on the wire, as a
runner's is not; it is kept in the state under `_guards`, which the reads
leave out. A firing puts one token in each output place, labelled as the
first token it took, unless `bodies` gives the transition a body: a
function from what each input handed over (the tokens taken, or a
survey's copy of every token) to the tokens produced.

Inner nets and keys (PROTOCOL §12, §13), as the server's 2026-10-12 relay
passes them: a token may hold inner nets (`seed_inner`), each with its own
protocol state and version, listed on the token as `nets` with a path
computed from where the token stands. The reads take `path` or `nested_id`
as query parameters (`execution/state`, `execution/history`,
`tokens/{id}`, `places/{place}/tokens`), `inject` takes them in its body;
both is 422 `invalid_params`, a net that is gone 404 `unknown_net`. An
inner net's events go out as `nested {path, nested_id, event: {method,
params}}` stamped with the outer version, the inner event carrying its own.
A step fires the outer net first and, when nothing there is fireable, the
first inner net that has a fireable transition. An outer firing that takes a
token holding nets moves them to the token it produces in a nested place,
and drops them otherwise. `boarding` makes a transition reach inside, as the
transit net's Board does: its taken token goes into the inner net held by
the first token of a place, as `nested` around `added`, then the holder is
`mutated`. With `one_piece_firings` set, every firing is reported in one
piece as the Rust runner's example binary reports it: no `launched`, the
firing's inner lines and `mutated`s first, then `fired {consumed, produced}`.
Places may declare `key_names` and tokens carry `keys`; produced
entries carry them as a fifth element. `POST .../query` and `GET
.../distinct` answer the protocol's results.

Every request is recorded in `requests`, so a test can see what the page
asked for, including anything this fake does not know about. Those unknown
paths get a 200 with `{}` and are also listed in `unknown_paths`.
"""

import copy
import json
import queue
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

STAMP = "2026-09-29T10:00:00+00:00"


@dataclass
class FakeControlPlane:
    """Everything the fake serves, and what it has seen.

    `allowed_origin` is the page's origin, echoed in the CORS headers the
    browser needs for credentialed cross-origin requests.
    """

    allowed_origin: str
    workers: list[dict[str, Any]] = field(default_factory=list)
    nets: list[dict[str, Any]] = field(default_factory=list)
    # Each net's protocol state, with every token listed: the state route
    # caps the lists at the page's `token_limit`, as a runner does.
    execution_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Each net's protocol log, oldest first.
    execution_history: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # What a reset rebuilds, by net; `seed_net` records it.
    initial_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Each net's inner nets by nested id: `{name, template, holder, state}`,
    # `holder` the id of the outer token holding it. `seed_inner` fills it
    # and `initial_inner` keeps what a reset rebuilds.
    inner_nets: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    initial_inner: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    # Per net, transitions that reach inside: name to (holder place, inner place).
    boarding: dict[str, dict[str, tuple[str, str]]] = field(default_factory=dict)
    # Per net, outer transitions with a body of their own: name to a function
    # from what each input place handed over (`launch`) to the tokens the
    # firing produces, as (place, label) in order.
    bodies: dict[str, dict[str, Callable[[dict[str, list[dict[str, Any]]]], list[tuple[str, str]]]]] = (
        field(default_factory=dict))
    # Report firings in one piece (`fired`, after the firing's other lines)
    # rather than as `launched` then `distributed`.
    one_piece_firings: bool = False
    # How many of the next steps outlast the control plane: answered with a
    # 504 `timeout` while the firing is launched, then distributed
    # `slow_step_s` later on the stream.
    slow_steps: int = 0
    slow_step_s: float = 1.0
    # What the worker's buffer holds, oldest first. A test may seed it;
    # `publish_worker` appends to it as the worker does. A replay is sent
    # after `replay_delay_s`, before anything live.
    worker_buffer: list[dict[str, Any]] = field(default_factory=list)
    replay_delay_s: float = 0.0
    # How many of the next worker stream requests to refuse with a 204, which
    # makes the browser's EventSource give up and leaves the reconnect to the
    # page's store.
    refuse_worker_streams: int = 0
    worker_stream_answers: list[dict[str, Any]] = field(default_factory=list)
    requests: list[str] = field(default_factory=list)
    unknown_paths: list[str] = field(default_factory=list)
    server_streams: list["queue.Queue[str | None]"] = field(default_factory=list)
    worker_streams: list["queue.Queue[str | None]"] = field(default_factory=list)
    # Which worker each open worker stream was opened for, by `id()` of its queue.
    worker_stream_owner: dict[int, str] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)
    stopping: threading.Event = field(default_factory=threading.Event)
    worker_seq: int = 0
    server_seq: int = 0
    port: int = 0


def worker_row(worker_id: str) -> dict[str, Any]:
    return {
        "id": worker_id,
        "name": "test-worker",
        "worker_category": "persistent",
        "worker_type": "fly_machine",
        "sprite_name": None,
        "fly_machine_id": "m1",
        "deployment_id": None,
        "image_tag": None,
        "memory_mb": 2048,
        "cpus": 2,
        "status": "ready",
        "status_detail": None,
        "url": None,
        "active_operations": 0,
        "created_at": STAMP,
        "updated_at": STAMP,
    }


def net_row(net_id: str, worker_id: str, *, name: str, execution_mode: str) -> dict[str, Any]:
    return {
        "id": net_id,
        "definition_name": name,
        "instance_name": "default",
        "factory_params": None,
        "image_tag": None,
        "deployment_id": None,
        "worker_id": worker_id,
        "load_state": "loaded",
        "load_error": None,
        "entry_module": "nets.monitor",
        "entry_function": name,
        "execution_mode": execution_mode,
        "schedule": None,
        "factory_params_schema": None,
        "step_wall_clock_timeout_seconds": None,
        "stall_after_seconds": None,
        "anomalies": [],
        "schedule_facts": None,
        "schedule_error": None,
        "desired_execution_state": "running",
        "last_run": None,
        "open_run": None,
        "pending_reason": None,
        "pending_since": None,
        "step_count": 0,
        "last_progress_at": None,
        "last_success_at": None,
        "next_run_at": None,
        "active_operation": None,
        "deployment": None,
        "newer_deployment": None,
        "created_at": STAMP,
        "updated_at": STAMP,
    }


def _broadcast(streams: list["queue.Queue[str | None]"], frame: str | None) -> None:
    for stream in list(streams):
        stream.put(frame)


def publish_worker(cp: FakeControlPlane, *, kind: str, data: dict[str, Any], net_id: str | None,
                   scope: str = "net", worker_id: str | None = None) -> None:
    """Send one worker event, numbered like the worker numbers them, to every
    open worker stream, or with `worker_id` only to that worker's."""
    with cp.lock:
        cp.worker_seq += 1
        event = {"seq": cp.worker_seq, "scope": scope, "net_id": net_id, "kind": kind,
                 "ts": STAMP, "data": data}
        state = cp.execution_state.get(net_id or "")
        if scope == "net" and state is not None:
            # The worker lifts these into the envelope of every net event.
            event["marking_version"] = state["marking_version"]
            event["running"] = state["running"]
        cp.worker_buffer.append(event)
        streams = cp.worker_streams if worker_id is None else [
            stream for stream in cp.worker_streams
            if cp.worker_stream_owner.get(id(stream)) == worker_id]
        _broadcast(streams, _worker_frame(event))


def _worker_frame(event: dict[str, Any]) -> str:
    return f"id: {event['seq']}\ndata: {json.dumps(event)}\n\n"


def catch_up(cp: FakeControlPlane, after: int) -> tuple[str, list[dict[str, Any]]]:
    """What the worker sends a stream opened at `after` before tailing live.

    Returns what kind of answer it is (`replay`, or the gap reason) and the
    events. Call with `cp.lock` held, so nothing is published between the
    answer and the stream starting to tail.
    """
    buffer = cp.worker_buffer
    if after > cp.worker_seq:
        reason = "restarted"
    elif after > 0 and buffer and after < buffer[0]["seq"] - 1:
        reason = "evicted"
    else:
        return "replay", [event for event in buffer if event["seq"] > after]
    marker = {"seq": 0 if reason == "restarted" else after, "scope": "worker", "net_id": None,
              "kind": "stream_gap", "ts": STAMP,
              "data": {"reason": reason, "after": after, "current_seq": cp.worker_seq}}
    return reason, [marker]


# -- the fake net: a protocol version 1 state the routes and tests move --

Guard = Callable[[dict[str, dict[str, Any]]], bool]


def net_state(*, net: str, places: list[dict[str, Any]], transitions: list[dict[str, Any]],
              edges: list[dict[str, Any]], marking: dict[str, list[dict[str, Any]]] | None = None,
              runtime: str = "python", running: bool = False, generation: int = 1,
              marking_version: int = 0, hints: dict[str, Any] | None = None,
              guards: dict[str, Guard] | None = None) -> dict[str, Any]:
    """A protocol state (§5) with every token listed. `guards` holds a
    transition back while its function of the marking's places, `{name:
    {count, tokens}}`, returns false."""
    marking = marking or {}
    topology: dict[str, Any] = {"places": places, "transitions": transitions, "edges": edges}
    if hints is not None:
        topology["hints"] = hints
    state = {
        "protocol_version": 1, "runtime": runtime, "net": net, "generation": generation,
        "marking_version": marking_version, "running": running, "topology": topology,
        "transitions": {t["name"]: {"enabled": True, "fireable": False, "in_flight": False}
                        for t in transitions},
        "marking": {"places": {
            p["name"]: {"count": len(marking.get(p["name"], [])),
                        "tokens": list(marking.get(p["name"], []))}
            for p in places}},
        "progress": {"step_count": 0, "last_fired": None, "fired_counts": {},
                     "last_progress_at": None},
    }
    if guards:
        state["_guards"] = dict(guards)
    _refresh_fireable(state)
    return state


def seed_net(cp: "FakeControlPlane", net_id: str, state: dict[str, Any],
             history: list[dict[str, Any]] | None = None) -> None:
    """Serve `state` for `net_id`, and rebuild it on a reset."""
    cp.execution_state[net_id] = state
    cp.initial_state[net_id] = copy.deepcopy(state)
    cp.execution_history[net_id] = list(history or [])
    cp.inner_nets[net_id] = {}
    cp.initial_inner[net_id] = {}


def seed_inner(cp: "FakeControlPlane", net_id: str, holder: str, *, name: str,
               state: dict[str, Any], template: str | None = None) -> str:
    """Give outer token `holder` an inner net with protocol state `state`
    (built with `net_state`); its nested id, minted here."""
    nets = cp.inner_nets.setdefault(net_id, {})
    nested_id = f"n{sum(len(each) for each in cp.inner_nets.values()) + 1}"
    nets[nested_id] = {"name": name, "template": template, "holder": holder, "state": state}
    cp.initial_inner.setdefault(net_id, {})[nested_id] = copy.deepcopy(nets[nested_id])
    return nested_id


def _place_of(state: dict[str, Any], token_id: str) -> str | None:
    return next((place for place, held in state["marking"]["places"].items()
                 if any(token["id"] == token_id for token in held["tokens"])), None)


def inner_path(cp: "FakeControlPlane", net_id: str, nested_id: str) -> str:
    """The path of an inner net as the marking stands (§12.1)."""
    record = cp.inner_nets[net_id][nested_id]
    outer = cp.execution_state[net_id]
    place = _place_of(outer, record["holder"]) if record["holder"] else None
    if place is None:
        return record.get("last_path", "")
    record["last_path"] = f"{outer['net']}/{place}/#{record['holder']}/{record['name']}"
    return record["last_path"]


def _count(state: dict[str, Any]) -> int:
    return sum(held["count"] for held in state["marking"]["places"].values())


def _nets_of(cp: "FakeControlPlane", net_id: str, token_id: str) -> list[dict[str, Any]]:
    """The `nets` entry of an outer token (§12.2), empty for one holding none."""
    entries = []
    for nested_id, record in cp.inner_nets.get(net_id, {}).items():
        if record["holder"] == token_id:
            entry = {"name": record["name"], "nested_id": nested_id,
                     "path": inner_path(cp, net_id, nested_id), "count": _count(record["state"])}
            if record["template"]:
                entry["template"] = record["template"]
            entries.append(entry)
    return entries


def _with_nets(cp: "FakeControlPlane", net_id: str, token: dict[str, Any]) -> dict[str, Any]:
    nets = _nets_of(cp, net_id, token["id"])
    return {**token, "nets": nets} if nets else token


def _resolve(cp: "FakeControlPlane", net_id: str, path: str | None,
             nested_id: str | None) -> str | None:
    """The nested id an address names, or None for the outer net."""
    if path is not None and nested_id is not None:
        raise Refusal(422, "invalid_params", "give path or nested_id, not both")
    nets = cp.inner_nets.get(net_id, {})
    if nested_id is not None:
        if nested_id not in nets:
            raise Refusal(404, "unknown_net", f"no inner net with nested id {nested_id!r}")
        return nested_id
    if path is not None:
        found = next((each for each in nets if inner_path(cp, net_id, each) == path), None)
        if found is None:
            raise Refusal(404, "unknown_net", f"no inner net at {path!r}")
        return found
    return None


def _target(cp: "FakeControlPlane", net_id: str, nested_id: str | None) -> dict[str, Any]:
    """The protocol state a call acts on: the outer net's or an inner net's."""
    return cp.execution_state[net_id] if nested_id is None else cp.inner_nets[net_id][nested_id]["state"]


def _key_names(state: dict[str, Any], place: str) -> list[str] | None:
    meta = next((p for p in state["topology"]["places"] if p["name"] == place), {})
    return meta.get("key_names")


def _keys_for(state: dict[str, Any], place: str, value: Any) -> dict[str, Any] | None:
    """The keys a keyed place derives: here, the value's fields of those names."""
    names = _key_names(state, place)
    if names is None:
        return None
    source = value if isinstance(value, dict) else {}
    return {name: source[name] for name in names if name in source}


def _input_edges(state: dict[str, Any], transition: str) -> list[tuple[str, str | None]]:
    """A transition's input places with their edges' kinds, in topology order."""
    return [(e["place"], e.get("kind")) for e in state["topology"]["edges"]
            if e["transition"] == transition and e["direction"] == "in"]


def _inputs(state: dict[str, Any], transition: str) -> list[str]:
    """The places a firing takes from: input edges that are not read edges.
    A drain edge takes every token of its place, zero or more; the others
    take the front one."""
    return [place for place, kind in _input_edges(state, transition)
            if kind not in ("snapshot", "mutate", "survey")]


def _outputs(state: dict[str, Any], transition: str) -> list[str]:
    return [e["place"] for e in state["topology"]["edges"]
            if e["transition"] == transition and e["direction"] == "out"]


def _can_fire(state: dict[str, Any], transition: str) -> bool:
    live = state["transitions"][transition]
    places = state["marking"]["places"]
    # A take needs a token in its place, and so do a mutate edge, which
    # hands one over, and a snapshot, which reads one; a drain or a survey
    # edge never holds the transition back (§5.2). A guard, if any, has the
    # last word.
    needed = [place for place, kind in _input_edges(state, transition)
              if kind not in ("drain", "survey")]
    guard = state.get("_guards", {}).get(transition)
    return (live["enabled"] and not live["in_flight"] and bool(_inputs(state, transition))
            and all(places[p]["count"] > 0 for p in needed)
            and (guard is None or guard(places)))


def _refresh_fireable(state: dict[str, Any]) -> bool:
    """Recompute each transition's `fireable`; whether the set changed."""
    changed = False
    for name, live in state["transitions"].items():
        fireable = _can_fire(state, name)
        changed = changed or live["fireable"] != fireable
        live["fireable"] = fireable
    return changed


def _next_id(state: dict[str, Any]) -> str:
    state["_next_id"] = state.get("_next_id") or 1 + max(
        [int(t["id"]) for p in state["marking"]["places"].values() for t in p["tokens"]] or [0])
    token_id = state["_next_id"]
    state["_next_id"] += 1
    return str(token_id)


def _notify(cp: "FakeControlPlane", net_id: str, kind: str, params: dict[str, Any],
            *, moves_version: bool, nested_id: str | None = None) -> None:
    """Publish one notification, stamped as a runner stamps it (§7). For an
    inner net it goes out wrapped in `nested` (§12.4): the inner version
    inside, the outer one on the wrapper."""
    outer = cp.execution_state[net_id]
    state = _target(cp, net_id, nested_id)
    if moves_version:
        state["marking_version"] += 1
    stamped = {**params, "marking_version": state["marking_version"], "running": outer["running"]}
    if nested_id is None:
        publish_worker(cp, kind=kind, net_id=net_id, data=stamped)
        return
    publish_worker(cp, kind="nested", net_id=net_id, data={
        "path": inner_path(cp, net_id, nested_id), "nested_id": nested_id,
        "event": {"method": kind, "params": stamped},
        "marking_version": outer["marking_version"], "running": outer["running"]})


def _notify_fireable(cp: "FakeControlPlane", net_id: str, nested_id: str | None = None) -> None:
    state = _target(cp, net_id, nested_id)
    if _refresh_fireable(state):
        _notify(cp, net_id, "fireable", {"transitions": [
            name for name, live in state["transitions"].items() if live["fireable"]]},
            moves_version=False, nested_id=nested_id)


def launch(cp: "FakeControlPlane", net_id: str, transition: str | None = None,
           nested_id: str | None = None) -> dict[str, Any] | None:
    """Take a firing's inputs and publish `launched`, or None if nothing can fire."""
    with cp.lock:
        state = _target(cp, net_id, nested_id)
        if transition is None:
            transition = next((name for name in state["transitions"] if _can_fire(state, name)), None)
        if transition is None or not _can_fire(state, transition):
            return None
        places = state["marking"]["places"]
        kinds = dict(_input_edges(state, transition))
        consumed = []
        for place in _inputs(state, transition):
            held = places[place]
            taken = list(held["tokens"]) if kinds[place] == "drain" else held["tokens"][:1]
            del held["tokens"][:len(taken)]
            held["count"] -= len(taken)
            consumed.extend((place, token) for token in taken)
        # What each input hands a body (`bodies`): the tokens taken from its
        # place, or for a survey a copy of every token there, zero or more.
        handed = {place: [token for source, token in consumed if source == place]
                  for place in _inputs(state, transition)}
        handed.update({place: copy.deepcopy(places[place]["tokens"])
                       for place, kind in kinds.items() if kind == "survey"})
        state["transitions"][transition]["in_flight"] = True
        _refresh_fireable(state)
        if not cp.one_piece_firings:
            _notify(cp, net_id, "launched", {
                "transition": transition,
                "consumed": [[place, token["id"]] for place, token in consumed]},
                moves_version=True, nested_id=nested_id)
        return {"transition": transition, "consumed": consumed, "handed": handed, "started_at": STAMP,
                "nested_id": nested_id}


def _board(cp: "FakeControlPlane", net_id: str, transition: str,
           consumed: list[tuple[str, dict[str, Any]]]) -> None:
    """A transition reaching inside, as the transit net's Board does: each
    taken token goes into the inner net held by the first token of the
    holder place (`nested` around `added`), then the holder is `mutated`."""
    holder_place, inner_place = cp.boarding.get(net_id, {}).get(transition, (None, None))
    if holder_place is None:
        return
    outer = cp.execution_state[net_id]
    holder = next(iter(outer["marking"]["places"][holder_place]["tokens"]), None)
    nested_id = next((each for each, record in cp.inner_nets.get(net_id, {}).items()
                      if holder is not None and record["holder"] == holder["id"]), None)
    if nested_id is None:
        return
    state = cp.inner_nets[net_id][nested_id]["state"]
    for _, token in consumed:
        record = {"id": _next_id(state), "label": token["label"]}
        state["marking"]["places"][inner_place]["tokens"].append(record)
        state["marking"]["places"][inner_place]["count"] += 1
        _notify(cp, net_id, "added", {"place": inner_place, **record}, moves_version=True,
                nested_id=nested_id)
    _notify(cp, net_id, "mutated", {"place": holder_place, "id": holder["id"], "label": holder["label"]},
            moves_version=True)


def _wire(state: dict[str, Any], place: str, token: dict[str, Any]) -> list[Any]:
    """A produced entry (§7.1): colour fourth, keys fifth for a keyed place."""
    if _key_names(state, place) is not None:
        return [place, token["id"], token["label"], token.get("color"), token.get("keys", {})]
    return [place, token["id"], token["label"], *([token["color"]] if token.get("color") else [])]


def _produce(cp: "FakeControlPlane", net_id: str, state: dict[str, Any],
             launched: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """What a firing puts out, as (place, the token it takes its label,
    colour and keys from): the body's tokens for an outer transition that
    has one (`bodies`), else one token in each output place copying the
    first token taken."""
    transition = launched["transition"]
    body = cp.bodies.get(net_id, {}).get(transition) if launched.get("nested_id") is None else None
    if body is not None:
        return [(place, {"label": label}) for place, label in body(launched["handed"])]
    consumed = launched["consumed"]
    source = consumed[0][1] if consumed else {"label": transition}
    return [(place, source) for place in _outputs(state, transition)]


def land(cp: "FakeControlPlane", net_id: str, launched: dict[str, Any],
         duration_ms: float = 12.5) -> list[list[str]]:
    """Place a launched firing's outputs, publish `distributed`, log it."""
    with cp.lock:
        nested_id = launched.get("nested_id")
        state = _target(cp, net_id, nested_id)
        transition = launched["transition"]
        consumed = launched["consumed"]
        places = state["marking"]["places"]
        if nested_id is None:
            _board(cp, net_id, transition, consumed)
        produced = []
        for place, source in _produce(cp, net_id, state, launched):
            token = {"id": _next_id(state), "label": source["label"]}
            if source.get("color"):
                token["color"] = source["color"]
            names = _key_names(state, place)
            if names is not None:
                token["keys"] = {name: value for name, value in (source.get("keys") or {}).items()
                                 if name in names}
            places[place]["tokens"].append(token)
            places[place]["count"] += 1
            produced.append((place, token))
        if nested_id is None:
            _carry_inner_nets(cp, net_id, consumed, produced)
        state["transitions"][transition]["in_flight"] = False
        progress = state["progress"]
        progress["step_count"] += 1
        progress["last_fired"] = transition
        progress["fired_counts"][transition] = progress["fired_counts"].get(transition, 0) + 1
        wire = [_wire(state, place, token) for place, token in produced]
        if cp.one_piece_firings:
            _notify(cp, net_id, "fired", {
                "transition": transition, "consumed": [[place, token["id"]] for place, token in consumed],
                "produced": wire, "duration_ms": duration_ms}, moves_version=True, nested_id=nested_id)
        else:
            _notify(cp, net_id, "distributed", {"transition": transition, "produced": wire,
                                                "duration_ms": duration_ms},
                    moves_version=True, nested_id=nested_id)
        history = cp.execution_history.setdefault(net_id, [])
        entry = {
            "seq": (history[-1]["seq"] if history else 0) + 1, "transition": transition,
            "started_at": launched["started_at"], "duration_ms": duration_ms, "outcome": "fired",
            "consumed": [[place, token["id"]] for place, token in consumed],
            "produced": [[place, token["id"]] for place, token in produced]}
        if nested_id is not None:
            entry["path"] = inner_path(cp, net_id, nested_id)
            entry["nested_id"] = nested_id
        history.append(entry)
        if nested_id is None:
            _notify_fireable(cp, net_id)
        else:
            _notify_fireable(cp, net_id, nested_id)
        return wire


def _carry_inner_nets(cp: "FakeControlPlane", net_id: str, consumed: list[tuple[str, dict[str, Any]]],
                      produced: list[tuple[str, dict[str, Any]]]) -> None:
    """The inner nets of a taken token: to the token produced in a nested
    place, keeping their nested ids (§12.6), or gone with the token."""
    nested_places = {p["name"] for p in cp.execution_state[net_id]["topology"]["places"] if p.get("nested")}
    keeper = next((token for place, token in produced if place in nested_places), None)
    taken = {token["id"] for _, token in consumed}
    nets = cp.inner_nets.get(net_id, {})
    for nested_id in list(nets):
        if nets[nested_id]["holder"] in taken:
            if keeper is None:
                del nets[nested_id]
            else:
                nets[nested_id]["holder"] = keeper["id"]


def fire(cp: "FakeControlPlane", net_id: str, transition: str | None = None) -> str | None:
    """One whole firing, as both runners report it: `launched`, then
    `distributed`. The transition that fired, or None."""
    launched = launch(cp, net_id, transition)
    if launched is None:
        return None
    land(cp, net_id, launched)
    return launched["transition"]


def fire_inner(cp: "FakeControlPlane", net_id: str, nested_id: str,
               transition: str | None = None) -> str | None:
    """One whole firing inside an inner net, each piece wrapped in `nested`."""
    launched = launch(cp, net_id, transition, nested_id)
    if launched is None:
        return None
    land(cp, net_id, launched)
    return launched["transition"]


def step_deep(cp: "FakeControlPlane", net_id: str) -> tuple[str, str | None] | None:
    """What a step fires (§12.3): the outer net's first fireable transition,
    else the first inner net's that has one. The transition and the nested
    id it fired in (None for the outer net), or None."""
    fired = fire(cp, net_id)
    if fired is not None:
        return fired, None
    for nested_id in list(cp.inner_nets.get(net_id, {})):
        fired = fire_inner(cp, net_id, nested_id)
        if fired is not None:
            return fired, nested_id
    return None


def inject(cp: "FakeControlPlane", net_id: str, place: str, token: Any,
           nested_id: str | None = None) -> str:
    """Append a token from outside and publish `added`; its id."""
    with cp.lock:
        state = _target(cp, net_id, nested_id)
        record: dict[str, Any] = {"id": _next_id(state), "label": json.dumps(token)}
        keys = _keys_for(state, place, token)
        if keys is not None:
            record["keys"] = keys
        state["marking"]["places"][place]["tokens"].append(record)
        state["marking"]["places"][place]["count"] += 1
        _notify(cp, net_id, "added", {"place": place, **record}, moves_version=True, nested_id=nested_id)
        _notify_fireable(cp, net_id, nested_id)
        return record["id"]


def remove(cp: "FakeControlPlane", net_id: str, place: str, token_id: str) -> None:
    """Remove a token from outside (§7.1 `removed`); its inner nets go with it."""
    with cp.lock:
        state = cp.execution_state[net_id]
        held = state["marking"]["places"][place]
        held["tokens"] = [token for token in held["tokens"] if token["id"] != token_id]
        held["count"] -= 1
        nets = cp.inner_nets.get(net_id, {})
        for nested_id in [each for each, record in nets.items() if record["holder"] == token_id]:
            del nets[nested_id]
        _notify(cp, net_id, "removed", {"place": place, "id": token_id}, moves_version=True)
        _notify_fireable(cp, net_id)


def reset(cp: "FakeControlPlane", net_id: str) -> None:
    """Rebuild the net (a new generation, its log empty) and publish `reloaded`."""
    with cp.lock:
        old = cp.execution_state[net_id]
        state = copy.deepcopy(cp.initial_state[net_id])
        state["generation"] = old["generation"] + 1
        state["marking_version"] = old["marking_version"]
        state["running"] = False
        cp.execution_state[net_id] = state
        cp.execution_history[net_id] = []
        cp.inner_nets[net_id] = copy.deepcopy(cp.initial_inner.get(net_id, {}))
        _notify(cp, net_id, "reloaded", {"generation": state["generation"], "reason": "reset"},
                moves_version=False)


def resync(cp: "FakeControlPlane", net_id: str) -> None:
    """A runtime saying it changed what it cannot describe: `reloaded`, same generation."""
    with cp.lock:
        state = cp.execution_state[net_id]
        _notify(cp, net_id, "reloaded", {"generation": state["generation"], "reason": "resync"},
                moves_version=False)


def toggle(cp: "FakeControlPlane", net_id: str, transition: str, enabled: bool) -> None:
    with cp.lock:
        state = cp.execution_state[net_id]
        live = state["transitions"][transition]
        if live["enabled"] != enabled:
            live["enabled"] = enabled
            _notify(cp, net_id, "toggled", {"transition": transition, "enabled": enabled},
                    moves_version=True)
            _notify_fireable(cp, net_id)


def served_state(state: dict[str, Any], token_limit: int) -> dict[str, Any]:
    """The state as `get_state {token_limit}` answers it: each list capped."""
    answer = {key: value for key, value in state.items() if not key.startswith("_")}
    answer["marking"] = {"places": {
        name: {"count": place["count"], "tokens": place["tokens"][:token_limit]}
        for name, place in state["marking"]["places"].items()}}
    return answer


def _served(cp: "FakeControlPlane", net_id: str, nested_id: str | None, token_limit: int) -> dict[str, Any]:
    """`get_state` of the outer net, its tokens carrying their `nets`, or of
    an inner net, carrying its address (§12.3)."""
    if nested_id is None:
        answer = served_state(cp.execution_state[net_id], token_limit)
        for held in answer["marking"]["places"].values():
            held["tokens"] = [_with_nets(cp, net_id, token) for token in held["tokens"]]
        return answer
    record = cp.inner_nets[net_id][nested_id]
    answer = served_state(record["state"], token_limit)
    answer.update({"net": record["name"], "path": inner_path(cp, net_id, nested_id),
                   "nested_id": nested_id})
    if record["template"]:
        answer["template"] = record["template"]
    return answer


def _address_of(cp: "FakeControlPlane", net_id: str, nested_id: str | None) -> dict[str, Any]:
    return {} if nested_id is None else {"path": inner_path(cp, net_id, nested_id), "nested_id": nested_id}


def _token_matches(state: dict[str, Any], place: str, token: dict[str, Any], filt: dict[str, Any]) -> bool:
    """§13.2: AND across clauses, OR within, by JSON type and value."""
    if filt.get("places") is not None and place not in filt["places"]:
        return False
    if filt.get("prefix") and not place.startswith(filt["prefix"]):
        return False
    keys = token.get("keys") or {}
    for clause in filt.get("clauses") or []:
        if "param" in clause or clause.get("key") not in keys:
            return False
        value = keys[clause["key"]]
        if not any(type(value) is type(each) and value == each for each in clause.get("values", [])):
            return False
    return True


def _query(cp: "FakeControlPlane", net_id: str, nested_id: str | None, body: dict[str, Any]) -> dict[str, Any]:
    state = _target(cp, net_id, nested_id)
    filt = body.get("filter") or {}
    serializable = {p["name"]: p["serializable"] for p in state["topology"]["places"]}
    matches = []
    for place, held in state["marking"]["places"].items():
        for token in held["tokens"]:
            if _token_matches(state, place, token, filt):
                match: dict[str, Any] = {"place": place, "token": token}
                if serializable[place]:
                    try:
                        match["json"] = json.loads(token["label"])
                    except ValueError:
                        match["json"] = token["label"]
                matches.append(match)
    limit = body.get("token_limit") or 200
    return {"marking_version": state["marking_version"], "count": len(matches),
            "matches": matches[:limit], **_address_of(cp, net_id, nested_id)}


def _distinct(cp: "FakeControlPlane", net_id: str, nested_id: str | None, key: str,
              places: list[str]) -> dict[str, Any]:
    state = _target(cp, net_id, nested_id)
    values: list[Any] = []
    for place, held in state["marking"]["places"].items():
        if places and place not in places:
            continue
        for token in held["tokens"]:
            value = (token.get("keys") or {}).get(key)
            if value is not None and not any(type(value) is type(v) and value == v for v in values):
                values.append(value)
    return {"marking_version": state["marking_version"], "key": key, "values": values}


class Refusal(Exception):
    """A protocol refusal: `{detail, reason}` with an HTTP status."""

    def __init__(self, status: int, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.status, self.reason, self.detail = status, reason, detail


def _net_or_refuse(cp: "FakeControlPlane", net_id: str) -> dict[str, Any]:
    state = cp.execution_state.get(net_id)
    if state is None:
        raise Refusal(409, "not_loaded", f"Net {net_id} is not loaded")
    return state


def _token_value(state: dict[str, Any], token_id: str) -> dict[str, Any]:
    serializable = {p["name"]: p["serializable"] for p in state["topology"]["places"]}
    types = {p["name"]: p.get("type_name", "") for p in state["topology"]["places"]}
    for place, held in state["marking"]["places"].items():
        for token in held["tokens"]:
            if token["id"] == token_id:
                common = {"id": token_id, "place": place, "type_name": types[place]}
                if token.get("keys") is not None:
                    common["keys"] = token["keys"]
                if serializable[place]:
                    try:
                        return {**common, "kind": "json", "value": json.loads(token["label"])}
                    except ValueError:
                        return {**common, "kind": "json", "value": token["label"]}
                return {**common, "kind": "text", "text": token["label"]}
    raise Refusal(404, "unknown_token", f"no live token {token_id}")


def _write_answer(cp: "FakeControlPlane", method: str, path: str, body: Any) -> Any:
    """What the execution proxy answers a write, or None for a path it does not know."""
    match = re.fullmatch(r"/api/nets/([^/]+)/(execution/(step|reset|start|stop)|inject|query"
                         r"|transitions/([^/]+)/(enable|disable))", path)
    if not match or method != "POST":
        return None
    net_id = match.group(1)
    state = _net_or_refuse(cp, net_id)
    if match.group(2) == "query":
        with cp.lock:
            body = body or {}
            return _query(cp, net_id, _resolve(cp, net_id, body.get("path"), body.get("nested_id")), body)
    action = match.group(3) or ("inject" if match.group(2) == "inject" else match.group(5))
    if action == "step":
        if cp.slow_steps > 0:
            cp.slow_steps -= 1
            launched = launch(cp, net_id)
            if launched is not None:
                timer = threading.Timer(cp.slow_step_s, land, args=(cp, net_id, launched))
                timer.daemon = True
                timer.start()
            raise Refusal(504, "timeout", "The step is still running; it lands on the stream")
        fired = step_deep(cp, net_id)
        state = cp.execution_state[net_id]
        result: dict[str, Any] = {"fired": fired is not None,
                                  "marking_version": state["marking_version"],
                                  "running": state["running"]}
        if fired is not None:
            result["transition"] = fired[0]
            result.update(_address_of(cp, net_id, fired[1]) if fired[1] in cp.inner_nets.get(net_id, {}) else {})
        return result
    if action == "reset":
        reset(cp, net_id)
        state = cp.execution_state[net_id]
        return {"status": "reset", "generation": state["generation"],
                "marking_version": state["marking_version"]}
    if action in ("start", "stop"):
        state["running"] = action == "start"
        return {"status": "started" if action == "start" else "stopped",
                "marking_version": state["marking_version"], "running": state["running"]}
    if action == "inject":
        body = body or {}
        with cp.lock:
            nested_id = _resolve(cp, net_id, body.get("path"), body.get("nested_id"))
            target = _target(cp, net_id, nested_id)
            place = body.get("place")
            known = {p["name"]: p for p in target["topology"]["places"]}
            if place not in known:
                raise Refusal(404, "unknown_place", f"no place named {place!r}")
            if not known[place]["serializable"]:
                raise Refusal(422, "not_serializable", f"{place} has no JSON form")
            token_id = inject(cp, net_id, place, body.get("token"), nested_id)
            return {"status": "injected", "id": token_id, "marking_version": target["marking_version"],
                    **_address_of(cp, net_id, nested_id)}
    transition = unquote(match.group(4))
    if transition not in state["transitions"]:
        raise Refusal(404, "unknown_transition", f"no transition named {transition!r}")
    toggle(cp, net_id, transition, action == "enable")
    return {"marking_version": cp.execution_state[net_id]["marking_version"]}


def publish_server(cp: FakeControlPlane, event: dict[str, Any]) -> None:
    """Send one control-plane event with the next per-user sequence number."""
    with cp.lock:
        cp.server_seq += 1
        body = {"seq": cp.server_seq, **event}
        _broadcast(cp.server_streams, f"id: {cp.server_seq}\ndata: {json.dumps(body)}\n\n")


def drop_worker_streams(cp: FakeControlPlane) -> None:
    """End every open worker stream, as a proxy restart or a network blip would."""
    with cp.lock:
        _broadcast(cp.worker_streams, None)


def _json_answer(cp: FakeControlPlane, path: str, query: str) -> Any:
    if path == "/api/auth/me":
        return {"id": "user-1", "email": "tester@example.com"}
    if path == "/api/workers":
        return cp.workers
    if path == "/api/nets":
        return cp.nets
    if path == "/api/events/history":
        return []
    if path in ("/api/deployments", "/api/notebooks"):
        return []
    if path == "/api/wiring":
        return {"workers": [], "nets": [], "notebooks": [], "bindings": [],
                "control_plane_build": None}
    match = re.fullmatch(r"/api/workers/([^/]+)", path)
    if match:
        row = next((worker for worker in cp.workers if worker["id"] == match.group(1)), None)
        if row is not None:
            return {**row, "assigned_nets": [
                {key: net[key] for key in ("id", "definition_name", "instance_name", "load_state",
                                           "entry_module", "entry_function")}
                for net in cp.nets if net["worker_id"] == row["id"]]}
    if re.fullmatch(r"/api/workers/[^/]+/logs/history", path):
        return []
    params = parse_qs(query)

    def one(name: str) -> str | None:
        return params[name][0] if name in params else None

    match = re.fullmatch(r"/api/nets/([^/]+)/execution/state", path)
    if match:
        with cp.lock:
            net_id = match.group(1)
            _net_or_refuse(cp, net_id)
            nested_id = _resolve(cp, net_id, one("path"), one("nested_id"))
            return _served(cp, net_id, nested_id, int(one("token_limit") or "200"))
    match = re.fullmatch(r"/api/nets/([^/]+)/execution/history", path)
    if match:
        net_id = match.group(1)
        _net_or_refuse(cp, net_id)
        after = int(params.get("after", ["0"])[0])
        limit = int(params.get("limit", ["1000"])[0])
        with cp.lock:
            nested_id = _resolve(cp, net_id, one("path"), one("nested_id"))
            entries = [e for e in cp.execution_history.get(net_id, []) if e["seq"] > after
                       and (nested_id is None or e.get("nested_id") == nested_id)]
        return {"entries": entries[:limit]}
    match = re.fullmatch(r"/api/nets/([^/]+)/tokens/([^/]+)", path)
    if match:
        with cp.lock:
            net_id = match.group(1)
            _net_or_refuse(cp, net_id)
            nested_id = _resolve(cp, net_id, one("path"), one("nested_id"))
            value = _token_value(_target(cp, net_id, nested_id), unquote(match.group(2)))
            if nested_id is None:
                nets = _nets_of(cp, net_id, value["id"])
                if nets:
                    value["nets"] = nets
            return {**value, **_address_of(cp, net_id, nested_id)}
    match = re.fullmatch(r"/api/nets/([^/]+)/places/([^/]+)/tokens", path)
    if match:
        with cp.lock:
            net_id = match.group(1)
            _net_or_refuse(cp, net_id)
            nested_id = _resolve(cp, net_id, one("path"), one("nested_id"))
            state = _target(cp, net_id, nested_id)
            place = unquote(match.group(2))
            if place not in state["marking"]["places"]:
                raise Refusal(404, "unknown_place", f"no place named {place!r}")
            held = state["marking"]["places"][place]
            offset, limit = int(one("offset") or "0"), int(one("limit") or "200")
            tokens = held["tokens"][offset:offset + limit]
            if nested_id is None:
                tokens = [_with_nets(cp, net_id, token) for token in tokens]
            return {"place": place, "marking_version": state["marking_version"], "count": held["count"],
                    "offset": offset, "limit": limit, "tokens": tokens,
                    "has_more": offset + limit < len(held["tokens"]), **_address_of(cp, net_id, nested_id)}
    match = re.fullmatch(r"/api/nets/([^/]+)/distinct", path)
    if match:
        with cp.lock:
            net_id = match.group(1)
            _net_or_refuse(cp, net_id)
            nested_id = _resolve(cp, net_id, one("path"), one("nested_id"))
            return _distinct(cp, net_id, nested_id, one("key") or "", params.get("places", []))
    if re.fullmatch(r"/api/nets/[^/]+/logs/history", path):
        return []
    cp.unknown_paths.append(path + (f"?{query}" if query else ""))
    return {}


def _handler_for(cp: FakeControlPlane) -> type[BaseHTTPRequestHandler]:
    """The request handler class, bound to one fake's state.

    `http.server` only takes a class, so this is the one class the harness
    needs; it holds no state of its own.
    """

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", cp.allowed_origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Vary", "Origin")

        def do_OPTIONS(self) -> None:
            cp.requests.append(f"OPTIONS {self.path}")
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Idempotency-Key")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            parts = urlsplit(self.path)
            cp.requests.append(f"GET {self.path}")
            if parts.path == "/api/events":
                self._stream(cp.server_streams)
                return
            match = re.fullmatch(r"/api/workers/([^/]+)/events", parts.path)
            if match:
                self._worker_stream(match.group(1), parts.query)
                return
            try:
                answer = _json_answer(cp, parts.path, parts.query)
            except Refusal as refusal:
                self._send_json({"detail": refusal.detail, "reason": refusal.reason}, refusal.status)
                return
            self._send_json(answer)

        def do_POST(self) -> None:
            self._write_method("POST")

        def do_PATCH(self) -> None:
            self._write_method("PATCH")

        def do_DELETE(self) -> None:
            self._write_method("DELETE")

        def _write_method(self, method: str) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            cp.requests.append(f"{method} {self.path}")
            try:
                body = json.loads(raw) if raw else None
                answer = _write_answer(cp, method, urlsplit(self.path).path, body)
            except Refusal as refusal:
                self._send_json({"detail": refusal.detail, "reason": refusal.reason}, refusal.status)
                return
            if answer is None:
                cp.unknown_paths.append(f"{method} {self.path}")
                answer = {}
            self._send_json(answer)

        def _send_json(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _worker_stream(self, worker_id: str, query: str) -> None:
            after = int(parse_qs(query).get("after", ["0"])[0])
            with cp.lock:
                if cp.refuse_worker_streams > 0:
                    cp.refuse_worker_streams -= 1
                    cp.worker_stream_answers.append({"after": after, "answer": "refused", "seqs": []})
                    refused = True
                else:
                    refused = False
                    answer, catch_up_events = catch_up(cp, after)
                    cp.worker_stream_answers.append({
                        "after": after, "answer": answer,
                        "seqs": [event["seq"] for event in catch_up_events]})
                    frames: "queue.Queue[str | None]" = queue.Queue()
                    cp.worker_streams.append(frames)
                    cp.worker_stream_owner[id(frames)] = worker_id
            if refused:
                self.send_response(204)
                self._cors()
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            delay = cp.replay_delay_s if answer == "replay" and catch_up_events else 0.0
            self._stream(cp.worker_streams, frames,
                         catch_up=[_worker_frame(event) for event in catch_up_events],
                         catch_up_delay_s=delay)

        def _stream(self, streams: list["queue.Queue[str | None]"],
                    frames: "queue.Queue[str | None] | None" = None,
                    catch_up: list[str] | None = None, catch_up_delay_s: float = 0.0) -> None:
            self.close_connection = True
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if frames is None:
                frames = queue.Queue()
                with cp.lock:
                    streams.append(frames)
            try:
                self.wfile.write(b": open\n\n")
                self.wfile.flush()
                if catch_up:
                    time.sleep(catch_up_delay_s)
                    for frame in catch_up:
                        self.wfile.write(frame.encode())
                    self.wfile.flush()
                while not cp.stopping.is_set():
                    try:
                        frame = frames.get(timeout=1.0)
                    except queue.Empty:
                        frame = ": keepalive\n\n"
                    if frame is None:
                        return
                    self.wfile.write(frame.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            finally:
                with cp.lock:
                    if frames in streams:
                        streams.remove(frames)
                    cp.worker_stream_owner.pop(id(frames), None)

    return Handler


def start(cp: FakeControlPlane) -> ThreadingHTTPServer:
    """Serve the fake on a free local port, recorded in `cp.port`."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(cp))
    server.daemon_threads = True
    cp.port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def stop(cp: FakeControlPlane, server: ThreadingHTTPServer) -> None:
    cp.stopping.set()
    with cp.lock:
        _broadcast(cp.server_streams, None)
        _broadcast(cp.worker_streams, None)
    server.shutdown()
    server.server_close()
