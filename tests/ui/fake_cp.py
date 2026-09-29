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

Every request is recorded in `requests`, so a test can see what the page
asked for, including anything this fake does not know about. Those unknown
paths get a 200 with `{}` and are also listed in `unknown_paths`.
"""

import json
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

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
    execution_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    execution_history: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
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
    lock: threading.Lock = field(default_factory=threading.Lock)
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
    match = re.fullmatch(r"/api/nets/([^/]+)/execution/state", path)
    if match:
        return cp.execution_state[match.group(1)]
    match = re.fullmatch(r"/api/nets/([^/]+)/execution/history", path)
    if match:
        return cp.execution_history.get(match.group(1), [])
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
            self._send_json(_json_answer(cp, parts.path, parts.query))

        def do_POST(self) -> None:
            self._write_method("POST")

        def do_PATCH(self) -> None:
            self._write_method("PATCH")

        def do_DELETE(self) -> None:
            self._write_method("DELETE")

        def _write_method(self, method: str) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            cp.requests.append(f"{method} {self.path}")
            cp.unknown_paths.append(f"{method} {self.path}")
            self._send_json({})

        def _send_json(self, payload: Any) -> None:
            body = json.dumps(payload).encode()
            self.send_response(200)
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
