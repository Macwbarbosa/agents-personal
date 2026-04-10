#!/usr/bin/env python3
"""
server.py - Servidor local do dashboard do Sr. Bazinga.

Serve arquivos estáticos e expõe um endpoint /api/sync que roda sync.py.

Uso:
    uv run --with google-api-python-client --with google-auth server.py
    Acessar: http://localhost:8765
"""

import json
import os
import subprocess
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import webbrowser

from env_loader import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")
PORT = int(os.getenv("DASHBOARD_PORT", "8765"))
STATIC = ROOT / "static"
DATA = ROOT / "data"
SYNC_SCRIPT = ROOT / "sync.py"
BITRIX_TASKS_WEBHOOK_URL = os.getenv("BITRIX_TASKS_WEBHOOK_URL", "").strip()
BITRIX_WEBHOOK_BASE_URL = os.getenv("BITRIX_WEBHOOK_BASE_URL", "").strip()


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


def run_sync_subprocess() -> dict:
    result = subprocess.run(
        [
            "uv",
            "run",
            "--with",
            "google-api-python-client",
            "--with",
            "google-auth",
            str(SYNC_SCRIPT),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return {
        "ok": result.returncode == 0,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        # Rotas principais
        if self.path == "/" or self.path == "/index.html":
            self.path = "/static/index.html"
        elif self.path.startswith("/static/") or self.path.startswith("/data/"):
            pass  # serve direto
        elif self.path == "/api/meta":
            self._serve_json(DATA / "meta.json")
            return
        elif self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/sync":
            self._run_sync()
            return
        if self.path == "/api/bitrix/access":
            self._bitrix_access()
            return
        if self.path == "/api/bitrix/update":
            self._bitrix_update()
            return
        if self.path == "/api/bitrix/comment":
            self._bitrix_comment()
            return
        if self.path == "/api/bitrix/action":
            self._bitrix_action()
            return
        self.send_error(404)

    def _serve_json(self, path: Path):
        if not path.exists():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _run_sync(self):
        try:
            payload = run_sync_subprocess()
            json_response(self, 200 if payload["ok"] else 500, payload)
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
            sync_payload = run_sync_subprocess()
            json_response(
                self,
                200 if sync_payload["ok"] else 500,
                {
                    "ok": sync_payload["ok"],
                    "message": "Tarefa atualizada no Bitrix",
                    "stdout": sync_payload["stdout"],
                    "stderr": sync_payload["stderr"],
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

            bitrix_request(
                "task.comment.add",
                {"TASKID": task_id, "FIELDS": {"POST_MESSAGE": text}},
            )
            sync_payload = run_sync_subprocess()
            json_response(
                self,
                200 if sync_payload["ok"] else 500,
                {
                    "ok": sync_payload["ok"],
                    "message": "Comentário enviado para o Bitrix",
                    "stdout": sync_payload["stdout"],
                    "stderr": sync_payload["stderr"],
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
            sync_payload = run_sync_subprocess()
            json_response(
                self,
                200 if sync_payload["ok"] else 500,
                {
                    "ok": sync_payload["ok"],
                    "message": f"Ação '{action}' executada no Bitrix",
                    "stdout": sync_payload["stdout"],
                    "stderr": sync_payload["stderr"],
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
