#!/usr/bin/env python3
from __future__ import annotations

import functools
import json
import os
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
STATE_FILE = Path(os.environ.get("ROV_WATER_STATE_FILE", Path.home() / ".hermes" / "rov-water-state.json"))
RESET_PASSWORD = os.environ.get("ROV_WATER_RESET_PASSWORD", "rov1")
RESET_HISTORY_LIMIT = 3
RUN_HISTORY_LIMIT = 5
TIMER_IDS = ("rov", "float")
LOCK = threading.Lock()


def now_ms() -> int:
    return int(time.time() * 1000)


def default_timer_state() -> dict:
    return {
        "running": False,
        "startedAt": None,
        "overallMs": 0,
        "currentRunMs": 0,
        "lastResetAt": None,
        "resetHistory": [],
        "runHistory": [],
    }


def default_state() -> dict:
    return {timer_id: default_timer_state() for timer_id in TIMER_IDS}


def normalize_reset_history(items) -> list[dict]:
    if not isinstance(items, list):
        return []

    normalized = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        at = entry.get("at")
        run_ms = entry.get("runMs")
        justification = entry.get("justification")
        if isinstance(at, (int, float)) and isinstance(run_ms, (int, float)):
            normalized.append({
                "at": int(at),
                "runMs": int(run_ms),
                "justification": justification.strip() if isinstance(justification, str) else "",
            })
    normalized.sort(key=lambda item: item["at"], reverse=True)
    return normalized[:RESET_HISTORY_LIMIT]


def normalize_run_history(items) -> list[dict]:
    if not isinstance(items, list):
        return []

    normalized = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        at = entry.get("at")
        run_ms = entry.get("runMs")
        if isinstance(at, (int, float)) and isinstance(run_ms, (int, float)):
            normalized.append({"at": int(at), "runMs": int(run_ms)})
    normalized.sort(key=lambda item: item["at"], reverse=True)
    return normalized[:RUN_HISTORY_LIMIT]


def normalize_timer_state(raw) -> dict:
    base = default_timer_state()
    if not isinstance(raw, dict):
        return base

    base["running"] = bool(raw.get("running", False))
    started_at = raw.get("startedAt")
    base["startedAt"] = int(started_at) if isinstance(started_at, (int, float)) else None
    overall_ms = raw.get("overallMs")
    current_run_ms = raw.get("currentRunMs")
    last_reset_at = raw.get("lastResetAt")
    base["overallMs"] = int(overall_ms) if isinstance(overall_ms, (int, float)) else 0
    base["currentRunMs"] = int(current_run_ms) if isinstance(current_run_ms, (int, float)) else 0
    base["lastResetAt"] = int(last_reset_at) if isinstance(last_reset_at, (int, float)) else None
    base["resetHistory"] = normalize_reset_history(raw.get("resetHistory"))
    base["runHistory"] = normalize_run_history(raw.get("runHistory"))
    return base


def load_state() -> dict:
    if not STATE_FILE.exists():
        return default_state()

    try:
        with STATE_FILE.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception:
        return default_state()

    if not isinstance(raw, dict):
        return default_state()

    timers = raw.get("timers")
    if not isinstance(timers, dict):
        timers = raw
    state = default_state()
    for timer_id in TIMER_IDS:
        state[timer_id] = normalize_timer_state(timers.get(timer_id))
    return state


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"timers": state}
    tmp_path = STATE_FILE.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
    tmp_path.replace(STATE_FILE)


def live_delta(timer_state: dict, current_now: int | None = None) -> int:
    if not timer_state.get("running"):
        return 0
    started_at = timer_state.get("startedAt")
    if not isinstance(started_at, int):
        return 0
    current_now = now_ms() if current_now is None else current_now
    return max(0, current_now - started_at)


def present_timer(timer_state: dict, current_now: int | None = None) -> dict:
    current_now = now_ms() if current_now is None else current_now
    delta = live_delta(timer_state, current_now=current_now)
    presented = dict(timer_state)
    presented["displayOverallMs"] = timer_state.get("overallMs", 0) + delta
    presented["displayCurrentRunMs"] = timer_state.get("currentRunMs", 0) + delta
    presented["resetHistory"] = list(timer_state.get("resetHistory", []))
    presented["runHistory"] = list(timer_state.get("runHistory", []))
    return presented


def present_state(state: dict) -> dict:
    current_now = now_ms()
    return {
        "serverNow": current_now,
        "timers": {timer_id: present_timer(timer_state, current_now=current_now) for timer_id, timer_state in state.items()},
    }


def update_running(timer_state: dict, current_now: int) -> None:
    if timer_state.get("running"):
        return
    timer_state["running"] = True
    timer_state["startedAt"] = current_now


def append_run_history(timer_state: dict, run_ms: int, current_now: int) -> None:
    if run_ms <= 0:
        return
    history = [{"at": current_now, "runMs": run_ms}] + list(timer_state.get("runHistory", []))
    history.sort(key=lambda item: item["at"], reverse=True)
    timer_state["runHistory"] = history[:RUN_HISTORY_LIMIT]


def toggle_timer(state: dict, timer_id: str) -> dict:
    current_now = now_ms()
    timer_state = state[timer_id]
    if timer_state.get("running"):
        delta = live_delta(timer_state, current_now=current_now)
        run_ms = timer_state.get("currentRunMs", 0) + delta
        timer_state["overallMs"] = timer_state.get("overallMs", 0) + delta
        timer_state["currentRunMs"] = run_ms
        append_run_history(timer_state, run_ms, current_now)
        timer_state["running"] = False
        timer_state["startedAt"] = None
    else:
        timer_state["currentRunMs"] = 0
        update_running(timer_state, current_now)
    return state


def reset_timer(state: dict, timer_id: str, justification: str) -> dict:
    current_now = now_ms()
    timer_state = state[timer_id]
    delta = live_delta(timer_state, current_now=current_now)
    lifetime_ms = timer_state.get("overallMs", 0) + delta
    if timer_state.get("running"):
        run_ms = timer_state.get("currentRunMs", 0) + delta
        append_run_history(timer_state, run_ms, current_now)
    timer_state["overallMs"] = 0
    timer_state["currentRunMs"] = 0
    timer_state["running"] = False
    timer_state["startedAt"] = None
    timer_state["lastResetAt"] = current_now
    timer_state["runHistory"] = []
    history = [{"at": current_now, "runMs": lifetime_ms, "justification": justification}] + list(timer_state.get("resetHistory", []))
    history.sort(key=lambda item: item["at"], reverse=True)
    timer_state["resetHistory"] = history[:RESET_HISTORY_LIMIT]
    return state


def send_json(handler: SimpleHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(data)


class RovWaterHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        super().log_message(format, *args)

    def do_HEAD(self) -> None:
        if self._handle_api(head_only=True):
            return
        super().do_HEAD()

    def do_GET(self) -> None:
        if self._handle_api(head_only=False):
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self._handle_api(head_only=False):
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def _handle_api(self, head_only: bool) -> bool:
        parsed = urlparse(self.path)
        parts = [part for part in parsed.path.split("/") if part]
        if not parts or parts[0] != "api":
            return False

        if parsed.path == "/api/state" and self.command in {"GET", "HEAD"}:
            with LOCK:
                payload = present_state(load_state())
            send_json(self, payload)
            return True

        if len(parts) >= 3 and parts[1] == "timers" and parts[2] in TIMER_IDS and self.command == "POST":
            timer_id = parts[2]
            action = parts[3] if len(parts) >= 4 else ""

            content_length = int(self.headers.get("Content-Length", "0") or 0)
            raw_body = self.rfile.read(content_length).decode("utf-8") if content_length else "{}"
            try:
                body = json.loads(raw_body) if raw_body else {}
            except Exception:
                body = {}

            with LOCK:
                state = load_state()
                if action == "toggle":
                    toggle_timer(state, timer_id)
                    save_state(state)
                    send_json(self, {"ok": True, **present_state(state)})
                    return True

                if action == "reset":
                    justification = body.get("justification")
                    justification = justification.strip() if isinstance(justification, str) else ""
                    if body.get("password") != RESET_PASSWORD:
                        send_json(self, {"ok": False, "error": "Wrong password."}, status=HTTPStatus.FORBIDDEN)
                        return True
                    if not justification:
                        send_json(self, {"ok": False, "error": "Justification required."}, status=HTTPStatus.BAD_REQUEST)
                        return True
                    reset_timer(state, timer_id, justification)
                    save_state(state)
                    send_json(self, {"ok": True, **present_state(state)})
                    return True

            send_json(self, {"ok": False, "error": "Unsupported action."}, status=HTTPStatus.BAD_REQUEST)
            return True

        if parsed.path == "/api/health" and self.command in {"GET", "HEAD"}:
            send_json(self, {"ok": True, "serverNow": now_ms()})
            return True

        send_json(self, {"ok": False, "error": "Not found."}, status=HTTPStatus.NOT_FOUND)
        return True


def main() -> None:
    handler = functools.partial(RovWaterHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 8000), handler)
    print(f"Serving {ROOT} on http://127.0.0.1:8000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
