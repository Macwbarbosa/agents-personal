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
import sys
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
            result = subprocess.run(
                [
                    "uv", "run",
                    "--with", "google-api-python-client",
                    "--with", "google-auth",
                    str(SYNC_SCRIPT),
                ],
                capture_output=True, text=True, timeout=60,
            )
            ok = result.returncode == 0
            payload = {
                "ok": ok,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200 if ok else 500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            body = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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
