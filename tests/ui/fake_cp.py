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

def net_state(*, net: str, places: list[dict[str, Any]], transitions: list[dict[str, Any]],
              edges: list[dict[str, Any]], marking: dict[str, list[dict[str, Any]]] | None = None,
              runtime: str = "python", running: bool = False, generation: int = 1,
              marking_version: int = 0, hints: dict[str, Any] | None = None) -> dict[str, Any]:
    """A protocol state (§5) with every token listed."""
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
    _refresh_fireable(state)
    return state


def seed_net(cp: "FakeControlPlane", net_id: str, state: dict[str, Any],
             history: list[dict[str, Any]] | None = None) -> None:
    """Serve `state` for `net_id`, and rebuild it on a reset."""
    cp.execution_state[net_id] = state
    cp.initial_state[net_id] = copy.deepcopy(state)
    cp.execution_history[net_id] = list(history or [])


def _inputs(state: dict[str, Any], transition: str) -> list[str]:
    """The places a firing takes from: input edges that are not read edges."""
    return [e["place"] for e in state["topology"]["edges"]
            if e["transition"] == transition and e["direction"] == "in"
            and e.get("kind") not in ("snapshot", "mutate")]


def _outputs(state: dict[str, Any], transition: str) -> list[str]:
    return [e["place"] for e in state["topology"]["edges"]
            if e["transition"] == transition and e["direction"] == "out"]


def _can_fire(state: dict[str, Any], transition: str) -> bool:
    live = state["transitions"][transition]
    places = state["marking"]["places"]
    inputs = _inputs(state, transition)
    return (live["enabled"] and not live["in_flight"] and bool(inputs)
            and all(places[p]["count"] > 0 for p in inputs))


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
            *, moves_version: bool) -> None:
    """Publish one notification, stamped as a runner stamps it (§7)."""
    state = cp.execution_state[net_id]
    if moves_version:
        state["marking_version"] += 1
    publish_worker(cp, kind=kind, net_id=net_id, data={
        **params, "marking_version": state["marking_version"], "running": state["running"]})


def _notify_fireable(cp: "FakeControlPlane", net_id: str) -> None:
    state = cp.execution_state[net_id]
    if _refresh_fireable(state):
        _notify(cp, net_id, "fireable", {"transitions": [
            name for name, live in state["transitions"].items() if live["fireable"]]},
            moves_version=False)


def launch(cp: "FakeControlPlane", net_id: str, transition: str | None = None) -> dict[str, Any] | None:
    """Take a firing's inputs and publish `launched`, or None if nothing can fire."""
    with cp.lock:
        state = cp.execution_state[net_id]
        if transition is None:
            transition = next((name for name in state["transitions"] if _can_fire(state, name)), None)
        if transition is None or not _can_fire(state, transition):
            return None
        places = state["marking"]["places"]
        consumed = []
        for place in _inputs(state, transition):
            token = places[place]["tokens"].pop(0)
            places[place]["count"] -= 1
            consumed.append((place, token))
        state["transitions"][transition]["in_flight"] = True
        _refresh_fireable(state)
        _notify(cp, net_id, "launched", {
            "transition": transition,
            "consumed": [[place, token["id"]] for place, token in consumed]}, moves_version=True)
        return {"transition": transition, "consumed": consumed, "started_at": STAMP}


def land(cp: "FakeControlPlane", net_id: str, launched: dict[str, Any],
         duration_ms: float = 12.5) -> list[list[str]]:
    """Place a launched firing's outputs, publish `distributed`, log it."""
    with cp.lock:
        state = cp.execution_state[net_id]
        transition = launched["transition"]
        consumed = launched["consumed"]
        places = state["marking"]["places"]
        produced = []
        for place in _outputs(state, transition):
            source = consumed[0][1] if consumed else {"label": transition}
            token = {"id": _next_id(state), "label": source["label"]}
            if source.get("color"):
                token["color"] = source["color"]
            places[place]["tokens"].append(token)
            places[place]["count"] += 1
            produced.append((place, token))
        state["transitions"][transition]["in_flight"] = False
        progress = state["progress"]
        progress["step_count"] += 1
        progress["last_fired"] = transition
        progress["fired_counts"][transition] = progress["fired_counts"].get(transition, 0) + 1
        wire = [[place, token["id"], token["label"], *([token["color"]] if token.get("color") else [])]
                for place, token in produced]
        _notify(cp, net_id, "distributed", {"transition": transition, "produced": wire,
                                            "duration_ms": duration_ms}, moves_version=True)
        history = cp.execution_history.setdefault(net_id, [])
        history.append({
            "seq": (history[-1]["seq"] if history else 0) + 1, "transition": transition,
            "started_at": launched["started_at"], "duration_ms": duration_ms, "outcome": "fired",
            "consumed": [[place, token["id"]] for place, token in consumed],
            "produced": [[place, token["id"]] for place, token in produced]})
        _notify_fireable(cp, net_id)
        return wire


def fire(cp: "FakeControlPlane", net_id: str, transition: str | None = None) -> str | None:
    """One whole firing, as both runners report it: `launched`, then
    `distributed`. The transition that fired, or None."""
    launched = launch(cp, net_id, transition)
    if launched is None:
        return None
    land(cp, net_id, launched)
    return launched["transition"]


def inject(cp: "FakeControlPlane", net_id: str, place: str, token: Any) -> str:
    """Append a token from outside and publish `added`; its id."""
    with cp.lock:
        state = cp.execution_state[net_id]
        record = {"id": _next_id(state), "label": json.dumps(token)}
        state["marking"]["places"][place]["tokens"].append(record)
        state["marking"]["places"][place]["count"] += 1
        _notify(cp, net_id, "added", {"place": place, **record}, moves_version=True)
        _notify_fireable(cp, net_id)
        return record["id"]


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
                if serializable[place]:
                    try:
                        return {**common, "kind": "json", "value": json.loads(token["label"])}
                    except ValueError:
                        return {**common, "kind": "json", "value": token["label"]}
                return {**common, "kind": "text", "text": token["label"]}
    raise Refusal(404, "unknown_token", f"no live token {token_id}")


def _write_answer(cp: "FakeControlPlane", method: str, path: str, body: Any) -> Any:
    """What the execution proxy answers a write, or None for a path it does not know."""
    match = re.fullmatch(r"/api/nets/([^/]+)/(execution/(step|reset|start|stop)|inject"
                         r"|transitions/([^/]+)/(enable|disable))", path)
    if not match or method != "POST":
        return None
    net_id = match.group(1)
    state = _net_or_refuse(cp, net_id)
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
        fired = fire(cp, net_id)
        state = cp.execution_state[net_id]
        result: dict[str, Any] = {"fired": fired is not None,
                                  "marking_version": state["marking_version"],
                                  "running": state["running"]}
        if fired is not None:
            result["transition"] = fired
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
        place = (body or {}).get("place")
        known = {p["name"]: p for p in state["topology"]["places"]}
        if place not in known:
            raise Refusal(404, "unknown_place", f"no place named {place!r}")
        if not known[place]["serializable"]:
            raise Refusal(422, "not_serializable", f"{place} has no JSON form")
        token_id = inject(cp, net_id, place, body.get("token"))
        return {"status": "injected", "id": token_id,
                "marking_version": cp.execution_state[net_id]["marking_version"]}
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
    match = re.fullmatch(r"/api/nets/([^/]+)/execution/state", path)
    if match:
        with cp.lock:
            state = _net_or_refuse(cp, match.group(1))
            return served_state(state, int(params.get("token_limit", ["200"])[0]))
    match = re.fullmatch(r"/api/nets/([^/]+)/execution/history", path)
    if match:
        _net_or_refuse(cp, match.group(1))
        after = int(params.get("after", ["0"])[0])
        limit = int(params.get("limit", ["1000"])[0])
        with cp.lock:
            entries = [e for e in cp.execution_history.get(match.group(1), []) if e["seq"] > after]
        return {"entries": entries[:limit]}
    match = re.fullmatch(r"/api/nets/([^/]+)/tokens/([^/]+)", path)
    if match:
        with cp.lock:
            return _token_value(_net_or_refuse(cp, match.group(1)), match.group(2))
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
