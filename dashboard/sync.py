#!/usr/bin/env python3
"""
sync.py - Coleta dados para o dashboard do Sr. Bazinga.

Lê arquivos de memória locais e busca dados do Gmail/Calendar via Google APIs
usando as credenciais OAuth já configuradas pelo workspace-mcp.

Uso:
    uv run --with google-api-python-client --with google-auth sync.py
"""

import base64
import html
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

try:
    from .env_loader import load_dotenv
except ImportError:
    from env_loader import load_dotenv

# Caminhos principais
ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
DASHBOARD = ROOT / "dashboard"
DATA_DIR = DASHBOARD / "data"
MEMORY = ROOT / "agents" / "sr-bazinga" / "memory"
USER_MD = ROOT / "USER.md"
GOOGLE_CREDS = Path(
    os.getenv(
        "GOOGLE_CREDS_PATH",
        "/Users/mac/.google_workspace_mcp/credentials/srbazinga01@gmail.com.json",
    )
)
BITRIX_TASKS_WEBHOOK_URL = os.getenv("BITRIX_TASKS_WEBHOOK_URL", "")
BITRIX_WEBHOOK_BASE_URL = os.getenv("BITRIX_WEBHOOK_BASE_URL", "")
BITRIX_PAGE_SIZE = 50
BITRIX_MAX_PAGES = 20
BITRIX_COMMENTS_PER_TASK = 5

BITRIX_STATUS_LABELS = {
    "2": "A fazer",
    "3": "Em andamento",
    "4": "Aguardando controle",
    "5": "Concluida",
    "6": "Adiada",
}

DATA_DIR.mkdir(parents=True, exist_ok=True)

DATASET_NAMES = (
    "meta",
    "pending",
    "projects",
    "people",
    "agents",
    "emails_inbox",
    "emails_sent",
    "calendar",
    "bitrix_tasks",
)


def write_json(name: str, data) -> None:
    path = DATA_DIR / f"{name}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ========= LEITURA DE MEMÓRIA =========

def parse_pending() -> list:
    """Parseia pending.md e retorna lista de tarefas."""
    path = MEMORY / "pending.md"
    if not path.exists():
        return []

    tasks = []
    current_section = "Geral"
    pattern = re.compile(r"^- \[( |x)\] (.+)$")

    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            current_section = line[3:].strip()
            continue
        m = pattern.match(line.strip())
        if m:
            done = m.group(1) == "x"
            text = m.group(2).strip()
            tasks.append({
                "section": current_section,
                "text": text,
                "done": done,
            })
    return tasks


def parse_projects() -> list:
    """Lê projetos ativos em memory/projects/."""
    projects = []
    projects_dir = MEMORY / "projects"
    if not projects_dir.exists():
        return projects

    for md_file in sorted(projects_dir.glob("*.md")):
        content = md_file.read_text(encoding="utf-8")
        # Primeira linha que começa com # é o título
        title = md_file.stem.replace("-", " ").title()
        for line in content.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        # Pega as primeiras 3 linhas não vazias como descrição
        desc_lines = [
            l.strip() for l in content.splitlines()
            if l.strip() and not l.startswith("#") and not l.startswith("---")
            and not l.startswith("*")
        ][:3]
        projects.append({
            "slug": md_file.stem,
            "title": title,
            "description": " ".join(desc_lines)[:200],
            "modified": datetime.fromtimestamp(md_file.stat().st_mtime).isoformat(),
        })
    return projects


def parse_people() -> list:
    """Parseia people.md — tabela da equipe."""
    path = MEMORY / "context" / "people.md"
    if not path.exists():
        return []

    people = []
    in_table = False
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("| Nome"):
            in_table = True
            continue
        if in_table and line.startswith("|---"):
            continue
        if in_table and line.startswith("|"):
            cells = [c.strip() for c in line.split("|")[1:-1]]
            if len(cells) >= 2 and cells[0]:
                people.append({
                    "name": cells[0].replace("**", ""),
                    "role": cells[1] if len(cells) > 1 else "",
                    "email": cells[2] if len(cells) > 2 else "",
                    "notes": cells[3] if len(cells) > 3 else "",
                })
        elif in_table and not line.startswith("|"):
            in_table = False
    return people


def parse_agents() -> list:
    """Lista agentes baseado em agents/*."""
    agents_dir = ROOT / "agents"
    agents = []
    if not agents_dir.exists():
        return agents

    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir():
            continue
        soul = agent_dir / "SOUL.md"
        memory_dir = agent_dir / "memory"
        sessions_dir = memory_dir / "sessions"

        last_session = None
        if sessions_dir.exists():
            sessions = sorted(sessions_dir.glob("*.md"), reverse=True)
            if sessions:
                last_session = sessions[0].stem

        agents.append({
            "slug": agent_dir.name,
            "name": agent_dir.name.replace("-", " ").title(),
            "status": "active" if soul.exists() else "unknown",
            "last_session": last_session,
        })
    return agents


# ========= GOOGLE APIs =========

def get_google_services():
    """Retorna (gmail, calendar) autenticados. None se falhar."""
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
    except ImportError:
        print("[aviso] google-api-python-client não instalado, pulando Gmail/Calendar")
        return None, None

    raw = None
    raw_env = os.getenv("GOOGLE_CREDS_JSON", "").strip()
    creds_from_env = bool(raw_env)
    if raw_env:
        try:
            raw = json.loads(raw_env)
        except json.JSONDecodeError as e:
            print(f"[erro] GOOGLE_CREDS_JSON invalido: {e}")
            return None, None
    elif GOOGLE_CREDS.exists():
        raw = json.loads(GOOGLE_CREDS.read_text())
    else:
        print(
            "[aviso] credenciais nao encontradas em GOOGLE_CREDS_JSON "
            f"nem em {GOOGLE_CREDS}"
        )
        return None, None

    creds = Credentials(
        token=raw.get("token"),
        refresh_token=raw.get("refresh_token"),
        token_uri=raw.get("token_uri"),
        client_id=raw.get("client_id"),
        client_secret=raw.get("client_secret"),
        scopes=raw.get("scopes"),
    )

    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                raw["token"] = creds.token
                raw["expiry"] = creds.expiry.isoformat() if creds.expiry else None
                if not creds_from_env:
                    GOOGLE_CREDS.write_text(json.dumps(raw, indent=2))
            except Exception as e:
                print(f"[erro] refresh falhou: {e}")
                return None, None

    gmail = build("gmail", "v1", credentials=creds, cache_discovery=False)
    calendar = build("calendar", "v3", credentials=creds, cache_discovery=False)
    return gmail, calendar


def fetch_emails(gmail, max_results: int = 10) -> list:
    """Busca últimos emails da inbox."""
    if not gmail:
        return []
    try:
        resp = gmail.users().messages().list(
            userId="me", labelIds=["INBOX"], maxResults=max_results
        ).execute()
        messages = resp.get("messages", [])
        emails = []
        for msg in messages:
            detail = gmail.users().messages().get(
                userId="me", id=msg["id"], format="full",
            ).execute()
            headers = {h["name"]: h["value"] for h in detail.get("payload", {}).get("headers", [])}
            emails.append({
                "id": msg["id"],
                "thread_id": detail.get("threadId", ""),
                "from": headers.get("From", ""),
                "to": headers.get("To", ""),
                "subject": headers.get("Subject", "(sem assunto)"),
                "date": headers.get("Date", ""),
                "snippet": detail.get("snippet", ""),
                "unread": "UNREAD" in detail.get("labelIds", []),
                "body_text": extract_gmail_body_text(detail.get("payload") or {}),
            })
        return emails
    except Exception as e:
        print(f"[erro] gmail: {e}")
        return []


def fetch_sent_emails(gmail, max_results: int = 5) -> list:
    """Busca últimos emails enviados pelo Bazinga."""
    if not gmail:
        return []
    try:
        resp = gmail.users().messages().list(
            userId="me", labelIds=["SENT"], maxResults=max_results
        ).execute()
        messages = resp.get("messages", [])
        emails = []
        for msg in messages:
            detail = gmail.users().messages().get(
                userId="me", id=msg["id"], format="full",
            ).execute()
            headers = {h["name"]: h["value"] for h in detail.get("payload", {}).get("headers", [])}
            emails.append({
                "id": msg["id"],
                "thread_id": detail.get("threadId", ""),
                "from": headers.get("From", ""),
                "to": headers.get("To", ""),
                "subject": headers.get("Subject", "(sem assunto)"),
                "date": headers.get("Date", ""),
                "snippet": detail.get("snippet", ""),
                "body_text": extract_gmail_body_text(detail.get("payload") or {}),
            })
        return emails
    except Exception as e:
        print(f"[erro] sent: {e}")
        return []


def decode_gmail_body(data: str) -> str:
    if not data:
        return ""
    try:
        raw = base64.urlsafe_b64decode(data.encode("utf-8"))
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return ""


def html_to_text(source: str) -> str:
    if not source:
        return ""
    text = re.sub(r"(?is)<(script|style).*?>.*?</\\1>", "", source)
    text = re.sub(r"(?i)<br\\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p>", "\n\n", text)
    text = re.sub(r"(?i)</div>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", "", text)
    text = html.unescape(text)
    text = text.replace("\r", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_gmail_body_text(payload: dict) -> str:
    plain_parts = []
    html_parts = []

    def walk(part: dict):
        mime_type = (part.get("mimeType") or "").lower()
        body_data = ((part.get("body") or {}).get("data") or "")
        decoded = decode_gmail_body(body_data)

        if decoded:
            if mime_type == "text/plain":
                plain_parts.append(decoded)
            elif mime_type == "text/html":
                html_parts.append(decoded)

        for child in part.get("parts", []) or []:
            walk(child)

    walk(payload or {})

    if plain_parts:
        return "\n\n".join(part.strip() for part in plain_parts if part.strip()).strip()
    if html_parts:
        return html_to_text("\n".join(html_parts))
    return ""


def fetch_calendar(calendar, days_ahead: int = 7) -> list:
    """Busca próximos eventos do calendário."""
    if not calendar:
        return []
    try:
        now = datetime.now(timezone.utc).isoformat()
        end = (datetime.now(timezone.utc) + timedelta(days=days_ahead)).isoformat()
        resp = calendar.events().list(
            calendarId="primary",
            timeMin=now,
            timeMax=end,
            maxResults=15,
            singleEvents=True,
            orderBy="startTime",
        ).execute()
        events = []
        for ev in resp.get("items", []):
            start = ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date")
            end_t = ev.get("end", {}).get("dateTime") or ev.get("end", {}).get("date")
            events.append({
                "id": ev.get("id"),
                "title": ev.get("summary", "(sem título)"),
                "start": start,
                "end": end_t,
                "location": ev.get("location", ""),
                "description": (ev.get("description", "") or "")[:200],
            })
        return events
    except Exception as e:
        print(f"[erro] calendar: {e}")
        return []


# ========= BITRIX =========

def with_query_param(url: str, key: str, value: str | None) -> str:
    """Atualiza um parametro de query sem perder os demais."""
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if value is None:
        query.pop(key, None)
    else:
        query[key] = value
    return urlunsplit(parts._replace(query=urlencode(query, doseq=True)))


def fetch_remote_json(url: str) -> dict:
    """Busca JSON via curl; se necessario, cai para urllib."""
    try:
        result = subprocess.run(
            ["curl", "-g", "--silent", "--show-error", "--location", url],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
        raise RuntimeError(result.stderr.strip() or f"curl retornou {result.returncode}")
    except FileNotFoundError:
        pass

    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.load(response)
    except ssl.SSLCertVerificationError:
        print("[aviso] certificado Bitrix nao validado pelo Python; usando fallback sem verificacao SSL")
        insecure = ssl.create_default_context()
        insecure.check_hostname = False
        insecure.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(url, timeout=30, context=insecure) as response:
            return json.load(response)


def build_bitrix_method_url(base_url: str, method_name: str) -> str:
    base = (base_url or "").strip()
    if not base:
        return ""
    if not base.endswith("/"):
        base += "/"
    return f"{base}{method_name}"


def build_bitrix_task_url(portal_base: str, task_id: str, responsible_id: str) -> str:
    if not portal_base or not task_id or not responsible_id:
        return ""
    return f"{portal_base}/company/personal/user/{responsible_id}/tasks/task/view/{task_id}/"


def fetch_bitrix_comments(task_id: str) -> list[dict]:
    """Busca comentarios legados da tarefa no Bitrix."""
    base_url = (BITRIX_WEBHOOK_BASE_URL or "").strip()
    if not base_url:
        return []

    comments_url = build_bitrix_method_url(base_url, "task.commentitem.getlist")
    if not comments_url:
        return []

    try:
        query = urlencode(
            {
                "TASKID": task_id,
                "ORDER[POST_DATE]": "desc",
            }
        )
        payload = fetch_remote_json(f"{comments_url}?{query}")
        items = payload.get("result") if isinstance(payload.get("result"), list) else []
        comments = []
        for item in items[:BITRIX_COMMENTS_PER_TASK]:
            comments.append(
                {
                    "id": str(item.get("ID") or ""),
                    "author_id": str(item.get("AUTHOR_ID") or ""),
                    "author_name": item.get("AUTHOR_NAME") or "Alguem",
                    "author_email": item.get("AUTHOR_EMAIL") or "",
                    "message": item.get("POST_MESSAGE") or "",
                    "created_at": item.get("POST_DATE") or "",
                }
            )
        return comments
    except Exception as e:
        print(f"[aviso] comentarios Bitrix task {task_id}: {e}")
        return []


def normalize_bitrix_task(task: dict, portal_base: str) -> dict:
    task_id = str(task.get("id") or "").strip()
    status = str(task.get("status") or "").strip()
    responsible = task.get("responsible") if isinstance(task.get("responsible"), dict) else {}
    creator = task.get("creator") if isinstance(task.get("creator"), dict) else {}
    group = task.get("group") if isinstance(task.get("group"), dict) else {}
    responsible_id = str(
        task.get("responsibleId") or responsible.get("id") or ""
    ).strip()

    comments = fetch_bitrix_comments(task_id)

    return {
        "id": task_id,
        "title": task.get("title") or f"Tarefa #{task_id}",
        "status": status,
        "status_label": BITRIX_STATUS_LABELS.get(status, f"Status {status or '-'}"),
        "done": status == "5",
        "deadline": task.get("deadline") or task.get("endDatePlan") or "",
        "changed_date": task.get("changedDate") or task.get("activityDate") or "",
        "created_date": task.get("createdDate") or "",
        "closed_date": task.get("closedDate") or "",
        "group_name": group.get("name") or "",
        "creator_name": creator.get("name") or "",
        "responsible_name": responsible.get("name") or "",
        "url": build_bitrix_task_url(portal_base, task_id, responsible_id),
        "comments": comments,
        "comments_count": len(comments),
    }


def sort_bitrix_tasks(tasks: list[dict]) -> list[dict]:
    def sort_key(task: dict):
        deadline = task.get("deadline") or "9999-12-31T23:59:59"
        changed = task.get("changed_date") or "9999-12-31T23:59:59"
        return (task.get("done", False), deadline, changed)

    return sorted(tasks, key=sort_key)


def fetch_bitrix_tasks() -> dict:
    """Busca tarefas do Bitrix via webhook REST."""
    webhook_url = (BITRIX_TASKS_WEBHOOK_URL or "").strip()
    if not webhook_url:
        return {
            "configured": False,
            "items": [],
            "total": 0,
            "open_count": 0,
            "completed_count": 0,
            "error": None,
        }

    portal = urlsplit(webhook_url)
    portal_base = f"{portal.scheme}://{portal.netloc}"

    try:
        tasks = []
        total = None

        for page in range(BITRIX_MAX_PAGES):
            start = page * BITRIX_PAGE_SIZE
            page_url = with_query_param(webhook_url, "start", None if start == 0 else str(start))
            payload = fetch_remote_json(page_url)

            if "error" in payload:
                desc = payload.get("error_description") or payload["error"]
                raise RuntimeError(desc)

            result = payload.get("result") or {}
            page_tasks = result.get("tasks") if isinstance(result, dict) else None
            if not isinstance(page_tasks, list):
                raise RuntimeError("Resposta inesperada do Bitrix para tasks.task.list")

            tasks.extend(page_tasks)
            total = int(payload.get("total") or len(tasks))

            if len(page_tasks) < BITRIX_PAGE_SIZE or len(tasks) >= total:
                break

        normalized = sort_bitrix_tasks(
            [normalize_bitrix_task(task, portal_base) for task in tasks]
        )
        open_count = sum(1 for task in normalized if not task["done"])
        completed_count = sum(1 for task in normalized if task["done"])

        return {
            "configured": True,
            "items": normalized,
            "total": len(normalized),
            "open_count": open_count,
            "completed_count": completed_count,
            "error": None,
        }
    except Exception as e:
        print(f"[erro] bitrix: {e}")
        return {
            "configured": True,
            "items": [],
            "total": 0,
            "open_count": 0,
            "completed_count": 0,
            "error": str(e),
        }


# ========= MAIN =========

def collect_dashboard_snapshot() -> dict:
    pending = parse_pending()
    projects = parse_projects()
    people = parse_people()
    agents = parse_agents()

    gmail, calendar = get_google_services()
    emails_inbox = fetch_emails(gmail) if gmail else []
    emails_sent = fetch_sent_emails(gmail) if gmail else []
    events = fetch_calendar(calendar) if calendar else []
    bitrix_tasks = fetch_bitrix_tasks()

    unread_count = sum(1 for e in emails_inbox if e["unread"])
    pending_count = sum(1 for t in pending if not t["done"])
    today = datetime.now().date()
    events_today = sum(
        1 for e in events
        if e["start"] and e["start"][:10] == today.isoformat()
    )

    meta = {
        "last_sync": datetime.now().isoformat(),
        "metrics": {
            "pending_tasks": pending_count,
            "unread_emails": unread_count,
            "events_today": events_today,
            "active_projects": len(projects),
            "active_agents": len(agents),
            "bitrix_open_tasks": bitrix_tasks["open_count"],
        },
        "integrations": {
            "bitrix": {
                "configured": bitrix_tasks["configured"],
                "error": bitrix_tasks["error"],
                "total": bitrix_tasks["total"],
            }
        },
    }

    return {
        "meta": meta,
        "pending": pending,
        "projects": projects,
        "people": people,
        "agents": agents,
        "emails_inbox": emails_inbox,
        "emails_sent": emails_sent,
        "calendar": events,
        "bitrix_tasks": bitrix_tasks,
    }


def write_snapshot(snapshot: dict) -> None:
    for name in DATASET_NAMES:
        write_json(name, snapshot.get(name))


def get_dataset_payload(name: str, snapshot: dict | None = None):
    if name not in DATASET_NAMES:
        raise KeyError(name)
    source = snapshot if snapshot is not None else collect_dashboard_snapshot()
    return source[name]


def main():
    print("Sincronizando dados do dashboard...")

    snapshot = collect_dashboard_snapshot()
    pending = snapshot["pending"]
    projects = snapshot["projects"]
    people = snapshot["people"]
    agents = snapshot["agents"]
    emails_inbox = snapshot["emails_inbox"]
    emails_sent = snapshot["emails_sent"]
    events = snapshot["calendar"]
    bitrix_tasks = snapshot["bitrix_tasks"]

    print(
        f"  memoria: {len(pending)} tarefas, {len(projects)} projetos,"
        f" {len(people)} pessoas, {len(agents)} agentes"
    )
    print(
        f"  google: {len(emails_inbox)} inbox, {len(emails_sent)} enviados,"
        f" {len(events)} eventos"
    )
    if bitrix_tasks["configured"]:
        print(
            "  bitrix:"
            f" {bitrix_tasks['open_count']} abertas, {bitrix_tasks['completed_count']} concluidas"
        )
    else:
        print("  bitrix: webhook nao configurado")

    write_snapshot(snapshot)

    print("Sync completo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
