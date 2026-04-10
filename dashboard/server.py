#!/usr/bin/env python3
"""
server.py - Servidor local do dashboard do Sr. Bazinga.

Serve arquivos estáticos e expõe APIs HTTP para o dashboard.

Uso:
    python3 server.py
    Acessar: http://localhost:8765
"""

import json
import os
import subprocess
import threading
import time
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import webbrowser

try:
    from .env_loader import load_dotenv
    from .sync import collect_dashboard_snapshot, get_dataset_payload
except ImportError:
    from env_loader import load_dotenv
    from sync import collect_dashboard_snapshot, get_dataset_payload

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")
PORT = int(os.getenv("DASHBOARD_PORT", "8765"))
BITRIX_TASKS_WEBHOOK_URL = os.getenv("BITRIX_TASKS_WEBHOOK_URL", "").strip()
BITRIX_WEBHOOK_BASE_URL = os.getenv("BITRIX_WEBHOOK_BASE_URL", "").strip()
BITRIX_CHAT_WEBHOOK_API_URL = os.getenv("BITRIX_CHAT_WEBHOOK_API_URL", "").strip()
SNAPSHOT_TTL_SECONDS = max(int(os.getenv("DASHBOARD_CACHE_TTL_SECONDS", "60")), 0)
SNAPSHOT_LOCK = threading.Lock()
SNAPSHOT_CACHE = {"data": None, "updated_at": 0.0}


def json_response(handler, status: int, payload: dict):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def parse_json_body(handler):
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        length = 0

    raw = handler.rfile.read(length) if length > 0 else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def load_snapshot(*, force: bool = False) -> dict:
    now = time.time()
    cached = SNAPSHOT_CACHE["data"]
    updated_at = SNAPSHOT_CACHE["updated_at"]
    if not force and cached is not None and (now - updated_at) < SNAPSHOT_TTL_SECONDS:
        return cached

    with SNAPSHOT_LOCK:
        now = time.time()
        cached = SNAPSHOT_CACHE["data"]
        updated_at = SNAPSHOT_CACHE["updated_at"]
        if not force and cached is not None and (now - updated_at) < SNAPSHOT_TTL_SECONDS:
            return cached

        fresh = collect_dashboard_snapshot()
        SNAPSHOT_CACHE["data"] = fresh
        SNAPSHOT_CACHE["updated_at"] = now
        return fresh


def refresh_snapshot() -> dict:
    return load_snapshot(force=True)


def normalize_webhook_roots() -> tuple[str, str]:
    source = BITRIX_WEBHOOK_BASE_URL or BITRIX_TASKS_WEBHOOK_URL
    if not source:
        raise RuntimeError("Webhook do Bitrix não configurado no .env")

    parsed = urllib.parse.urlsplit(source)
    parts = [part for part in parsed.path.split("/") if part]
    if "rest" not in parts:
        raise RuntimeError("URL do webhook do Bitrix inválida")

    rest_idx = parts.index("rest")
    tail = parts[rest_idx + 1 :]

    if len(tail) >= 3 and tail[0] == "api":
        user_id, token = tail[1], tail[2]
    elif len(tail) >= 2:
        user_id, token = tail[0], tail[1]
    else:
        raise RuntimeError("URL do webhook do Bitrix inválida")

    classic = urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, f"/rest/{user_id}/{token}/", "", "")
    )
    api = urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, f"/rest/api/{user_id}/{token}/", "", "")
    )
    return classic, api


def build_method_url(base_url: str, method_name: str) -> str:
    base = (base_url or "").strip()
    if not base:
        raise RuntimeError("URL base do Bitrix não configurada")
    if not base.endswith("/"):
        base += "/"
    return f"{base}{method_name}"


def bitrix_request(method_name: str, payload: dict | None = None, *, use_api: bool = False):
    classic_root, api_root = normalize_webhook_roots()
    root = api_root if use_api else classic_root
    url = f"{root}{method_name}"
    body = json.dumps(payload or {}, ensure_ascii=False)

    result = subprocess.run(
        [
            "curl",
            "-g",
            "--silent",
            "--show-error",
            "--location",
            "-H",
            "Content-Type: application/json",
            "-H",
            "Accept: application/json",
            "-X",
            "POST",
            "-d",
            body,
            url,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"curl retornou {result.returncode}")

    data = json.loads(result.stdout)
    if isinstance(data.get("error"), dict):
        error = data["error"]
        details = error.get("validation") or []
        validation = "; ".join(item.get("message", "") for item in details if isinstance(item, dict))
        raise RuntimeError(validation or error.get("message") or "Erro do Bitrix")
    if "error" in data:
        description = data.get("error_description")
        if isinstance(description, str):
            description = description.replace("<br>", " ").strip()
        raise RuntimeError(description or str(data["error"]))
    return data


def bitrix_request_by_url(base_url: str, method_name: str, payload: dict | None = None):
    url = build_method_url(base_url, method_name)
    body = json.dumps(payload or {}, ensure_ascii=False)

    result = subprocess.run(
        [
            "curl",
            "-g",
            "--silent",
            "--show-error",
            "--location",
            "-H",
            "Content-Type: application/json",
            "-H",
            "Accept: application/json",
            "-X",
            "POST",
            "-d",
            body,
            url,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"curl retornou {result.returncode}")

    data = json.loads(result.stdout)
    if isinstance(data.get("error"), dict):
        error = data["error"]
        raise RuntimeError(error.get("message") or "Erro do Bitrix")
    if "error" in data:
        description = data.get("error_description")
        if isinstance(description, str):
            description = description.replace("<br>", " ").strip()
        raise RuntimeError(description or str(data["error"]))
    return data


def run_sync() -> dict:
    snapshot = refresh_snapshot()
    return {
        "ok": True,
        "snapshot": snapshot,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        route_path = parsed.path

        if route_path == "/" or route_path == "/index.html":
            self.path = "/static/index.html"
            return super().do_GET()
        if route_path.startswith("/static/"):
            return super().do_GET()
        if route_path == "/api/bootstrap":
            self._bootstrap()
            return
        if route_path.startswith("/data/") and route_path.endswith(".json"):
            dataset_name = route_path.removeprefix("/data/").removesuffix(".json")
            self._serve_dataset(dataset_name)
            return
        if route_path == "/api/meta":
            self._serve_dataset("meta")
            return
        if route_path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        route_path = parsed.path

        if route_path == "/api/sync":
            self._run_sync()
            return
        if route_path == "/api/bitrix/access":
            self._bitrix_access()
            return
        if route_path == "/api/bitrix/update":
            self._bitrix_update()
            return
        if route_path == "/api/bitrix/comment":
            self._bitrix_comment()
            return
        if route_path == "/api/bitrix/action":
            self._bitrix_action()
            return
        self.send_error(404)

    def _serve_dataset(self, dataset_name: str):
        try:
            payload = get_dataset_payload(dataset_name, load_snapshot())
        except KeyError:
            self.send_error(404)
            return

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bootstrap(self):
        snapshot = load_snapshot()
        json_response(self, 200, {"ok": True, "datasets": snapshot})

    def _run_sync(self):
        try:
            payload = run_sync()
            meta = payload["snapshot"].get("meta", {})
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "last_sync": meta.get("last_sync"),
                    "metrics": meta.get("metrics", {}),
                },
            )
        except Exception as e:
            json_response(self, 500, {"ok": False, "error": str(e)})

    def _bitrix_access(self):
        try:
            payload = parse_json_body(self)
            task_id = int(payload.get("task_id"))
            bitrix = bitrix_request(
                "task.item.getallowedtaskactionsasstrings",
                {"TASKID": task_id},
            )
            raw = bitrix.get("result", {}) if isinstance(bitrix.get("result"), dict) else {}
            result = {
                "read": True,
                "edit": bool(raw.get("ACTION_EDIT")),
                "complete": bool(raw.get("ACTION_COMPLETE")),
                "start": bool(raw.get("ACTION_START")),
                "defer": bool(raw.get("ACTION_DEFER")),
                "renew": bool(raw.get("ACTION_RENEW")),
                "changeStatus": any(
                    bool(raw.get(key))
                    for key in ("ACTION_START", "ACTION_COMPLETE", "ACTION_DEFER", "ACTION_RENEW")
                ),
                "raw": raw,
            }
            json_response(self, 200, {"ok": True, "result": result})
        except Exception as e:
            json_response(self, 500, {"ok": False, "error": str(e)})

    def _bitrix_update(self):
        try:
            payload = parse_json_body(self)
            task_id = int(payload.get("task_id"))
            fields = {}

            title = (payload.get("title") or "").strip()
            if title:
                fields["title"] = title

            if "deadline" in payload:
                fields["deadline"] = (payload.get("deadline") or "").strip()

            if not fields:
                raise RuntimeError("Nenhum campo para atualizar foi enviado")

            bitrix_request(
                "task.item.update",
                {"TASKID": task_id, "taskId": task_id, "fields": fields},
            )
            snapshot = refresh_snapshot()
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "message": "Tarefa atualizada no Bitrix",
                    "last_sync": snapshot.get("meta", {}).get("last_sync"),
                },
            )
        except Exception as e:
            json_response(self, 500, {"ok": False, "error": str(e)})

    def _bitrix_comment(self):
        try:
            payload = parse_json_body(self)
            task_id = int(payload.get("task_id"))
            text = (payload.get("text") or "").strip()
            if not text:
                raise RuntimeError("Comentário vazio")

            if BITRIX_CHAT_WEBHOOK_API_URL:
                bitrix_request_by_url(
                    BITRIX_CHAT_WEBHOOK_API_URL,
                    "tasks.task.chat.message.send",
                    {"fields": {"taskId": task_id, "text": text}},
                )
            else:
                bitrix_request(
                    "task.comment.add",
                    {"TASKID": task_id, "COMMENTTEXT": text},
                )
            snapshot = refresh_snapshot()
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "message": (
                        "Mensagem enviada para o chat da tarefa"
                        if BITRIX_CHAT_WEBHOOK_API_URL
                        else "Comentário legado enviado para o Bitrix"
                    ),
                    "last_sync": snapshot.get("meta", {}).get("last_sync"),
                },
            )
        except Exception as e:
            json_response(self, 500, {"ok": False, "error": str(e)})

    def _bitrix_action(self):
        method_map = {
            "start": "task.item.startexecution",
            "complete": "task.item.complete",
            "defer": "task.item.defer",
            "renew": "task.item.renew",
        }
        try:
            payload = parse_json_body(self)
            task_id = int(payload.get("task_id"))
            action = (payload.get("action") or "").strip()
            method_name = method_map.get(action)
            if not method_name:
                raise RuntimeError("Ação do Bitrix inválida")

            bitrix_request(method_name, {"TASKID": task_id, "taskId": task_id})
            snapshot = refresh_snapshot()
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "message": f"Ação '{action}' executada no Bitrix",
                    "last_sync": snapshot.get("meta", {}).get("last_sync"),
                },
            )
        except Exception as e:
            json_response(self, 500, {"ok": False, "error": str(e)})

    def log_message(self, format, *args):
        # Silencioso por padrão (descomente para debug)
        # sys.stderr.write(f"[{self.address_string()}] {format % args}\n")
        pass


def main():
    url = f"http://localhost:{PORT}"
    print(f"Dashboard do Sr. Bazinga rodando em {url}")
    print("Ctrl+C para parar.")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    server = HTTPServer(("127.0.0.1", PORT), DashboardHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando.")
        server.shutdown()


if __name__ == "__main__":
    main()
