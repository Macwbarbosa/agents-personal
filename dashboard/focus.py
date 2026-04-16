#!/usr/bin/env python3
"""
focus.py - Gerenciamento do "Foco do Dia" do Sr. Bazinga.

Armazena focos por dia em data/focus.json e oferece:
- load_focus(date)            -> lê focos de um dia
- save_focus(date, payload)   -> persiste focos de um dia
- list_focus_history()        -> retorna o dict completo
- toggle_focus(date, id)      -> marca/desmarca um foco
- add_focus(date, text, ...)  -> adiciona foco manual
- remove_focus(date, id)      -> remove foco
- migrate_unresolved(today)   -> traz pendentes do(s) dia(s) anterior(es)
- suggest_focus(today, snap)  -> gera sugestões a partir de Bitrix/email/agenda
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
FOCUS_FILE = DATA_DIR / "focus.json"
_LOCK = threading.Lock()

# Limite de dias anteriores a considerar na migração
MIGRATE_LOOKBACK_DAYS = 14


# ---------- persistência ----------

def _read_all() -> dict:
    if not FOCUS_FILE.exists():
        return {}
    try:
        return json.loads(FOCUS_FILE.read_text(encoding="utf-8")) or {}
    except json.JSONDecodeError:
        return {}


def _write_all(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FOCUS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _day_entry(data: dict, day: str) -> dict:
    entry = data.get(day)
    if not isinstance(entry, dict):
        entry = {"items": [], "generated_at": None, "manually_edited": False}
        data[day] = entry
    entry.setdefault("items", [])
    entry.setdefault("generated_at", None)
    entry.setdefault("manually_edited", False)
    return entry


def _today_iso() -> str:
    return date.today().isoformat()


# ---------- API pública ----------

def list_focus_history() -> dict:
    with _LOCK:
        return _read_all()


def load_focus(day: str | None = None) -> dict:
    day = day or _today_iso()
    with _LOCK:
        data = _read_all()
        return dict(_day_entry(data, day), date=day)


def save_focus(day: str, items: list[dict]) -> dict:
    with _LOCK:
        data = _read_all()
        entry = _day_entry(data, day)
        entry["items"] = items
        entry["manually_edited"] = True
        _write_all(data)
        return dict(entry, date=day)


def add_focus(day: str, text: str, source: str = "manual") -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("Texto do foco vazio")
    with _LOCK:
        data = _read_all()
        entry = _day_entry(data, day)
        item = {
            "id": f"f_{uuid.uuid4().hex[:8]}",
            "text": text,
            "source": source,
            "done": False,
            "added_at": datetime.now().isoformat(timespec="seconds"),
            "origin_date": day,
        }
        entry["items"].append(item)
        entry["manually_edited"] = True
        _write_all(data)
        return item


def toggle_focus(day: str, focus_id: str) -> dict | None:
    with _LOCK:
        data = _read_all()
        entry = _day_entry(data, day)
        for item in entry["items"]:
            if item.get("id") == focus_id:
                item["done"] = not item.get("done", False)
                item["completed_at"] = (
                    datetime.now().isoformat(timespec="seconds") if item["done"] else None
                )
                entry["manually_edited"] = True
                _write_all(data)
                return item
        return None


def remove_focus(day: str, focus_id: str) -> bool:
    with _LOCK:
        data = _read_all()
        entry = _day_entry(data, day)
        before = len(entry["items"])
        entry["items"] = [i for i in entry["items"] if i.get("id") != focus_id]
        if len(entry["items"]) == before:
            return False
        entry["manually_edited"] = True
        _write_all(data)
        return True


# ---------- migração e sugestão ----------

def _age_tag(origin: str, today: str) -> str:
    try:
        delta = (date.fromisoformat(today) - date.fromisoformat(origin)).days
    except ValueError:
        return ""
    if delta <= 0:
        return ""
    if delta == 1:
        return "(ontem)"
    return f"({delta} dias)"


def migrate_unresolved(today: str | None = None) -> list[dict]:
    """Traz para `today` todos os focos não-resolvidos dos últimos dias.

    Retorna a lista final de itens migrados (já presente no arquivo).
    Itens já existentes em `today` (mesmo texto/id) não são duplicados.
    """
    today = today or _today_iso()
    with _LOCK:
        data = _read_all()
        today_entry = _day_entry(data, today)
        existing_ids = {i.get("id") for i in today_entry["items"]}
        existing_texts = {i.get("text", "").strip() for i in today_entry["items"]}

        limit_date = date.fromisoformat(today) - timedelta(days=MIGRATE_LOOKBACK_DAYS)

        for day_str in sorted(data.keys()):
            if day_str >= today:
                continue
            try:
                if date.fromisoformat(day_str) < limit_date:
                    continue
            except ValueError:
                continue

            entry = data[day_str]
            for item in entry.get("items", []):
                if item.get("done"):
                    continue
                text = item.get("text", "").strip()
                if not text or item.get("id") in existing_ids or text in existing_texts:
                    continue
                origin = item.get("origin_date") or day_str
                migrated = dict(item)
                migrated["origin_date"] = origin
                migrated["age_tag"] = _age_tag(origin, today)
                migrated["migrated"] = True
                today_entry["items"].append(migrated)
                existing_ids.add(migrated.get("id"))
                existing_texts.add(text)

        _write_all(data)
        return today_entry["items"]


def _parse_dt(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def suggest_focus(today: str | None, snapshot: dict) -> dict:
    """Gera sugestões de foco para `today` a partir do snapshot do dashboard.

    Regras (na ordem):
    1. Bitrix atrasadas -> "Destravar <título>"
    2. Bitrix com deadline hoje -> "Concluir <título>"
    3. Reuniões de hoje com duração >= 30min -> "Preparar <título>"
    4. Emails não lidos com mais de 2 dias -> "Responder <remetente>"

    Itens já presentes no foco do dia (por `source`) não são duplicados.
    """
    today = today or _today_iso()
    today_date = date.fromisoformat(today)

    existing = load_focus(today)
    existing_sources = {i.get("source") for i in existing.get("items", []) if i.get("source")}
    existing_texts = {i.get("text", "").strip() for i in existing.get("items", [])}

    suggestions: list[dict] = []

    def push(text: str, source: str):
        text = text.strip()
        if not text or source in existing_sources or text in existing_texts:
            return
        suggestions.append({
            "id": f"f_{uuid.uuid4().hex[:8]}",
            "text": text,
            "source": source,
            "done": False,
            "added_at": datetime.now().isoformat(timespec="seconds"),
            "origin_date": today,
            "suggested": True,
        })
        existing_sources.add(source)
        existing_texts.add(text)

    # --- Bitrix ---
    bitrix = snapshot.get("bitrix_tasks") or {}
    for task in bitrix.get("items", []) or []:
        if task.get("done"):
            continue
        deadline_dt = _parse_dt(task.get("deadline", ""))
        if not deadline_dt:
            continue
        deadline_day = deadline_dt.date()
        title = (task.get("title") or f"Tarefa #{task.get('id')}").strip()
        source = f"bitrix:{task.get('id')}"
        if deadline_day < today_date:
            push(f"Destravar: {title}", source)
        elif deadline_day == today_date:
            push(f"Concluir hoje: {title}", source)

    # --- Calendar / reuniões (Google + Outlook unificados) ---
    merged_events = (snapshot.get("calendar") or []) + (snapshot.get("m365_calendar") or [])
    for ev in merged_events:
        start_dt = _parse_dt(ev.get("start", ""))
        end_dt = _parse_dt(ev.get("end", ""))
        if not start_dt:
            continue
        if start_dt.date() != today_date:
            continue
        if end_dt and (end_dt - start_dt) < timedelta(minutes=30):
            continue
        title = (ev.get("title") or "reunião").strip()
        source = f"calendar:{ev.get('id')}"
        push(f"Preparar: {title}", source)

    # --- Emails antigos não lidos (Gmail) ---
    for mail in snapshot.get("emails_inbox") or []:
        if not mail.get("unread"):
            continue
        mail_dt = _parse_dt(mail.get("date", "")) or None
        if mail_dt and (datetime.now(mail_dt.tzinfo) - mail_dt) < timedelta(days=2):
            continue
        subject = (mail.get("subject") or "(sem assunto)").strip()
        sender = (mail.get("from") or "").split("<")[0].strip() or "remetente"
        source = f"gmail:{mail.get('id')}"
        push(f"Responder {sender}: {subject}", source)

    # --- Emails antigos não lidos (Outlook) ---
    for mail in snapshot.get("outlook_inbox") or []:
        if not mail.get("unread") and not mail.get("flagged"):
            continue
        mail_dt = _parse_dt(mail.get("received", "") or "")
        if mail_dt and (datetime.now(mail_dt.tzinfo) - mail_dt) < timedelta(days=2) and not mail.get("flagged"):
            continue
        subject = (mail.get("subject") or "(sem assunto)").strip()
        sender = (mail.get("from_name") or mail.get("from_email") or "remetente").strip()
        source = f"outlook:{mail.get('id')}"
        push(f"Responder {sender}: {subject}", source)

    # Salva as novas sugestões acrescentando no topo (preservando o que já estava)
    if suggestions:
        with _LOCK:
            data = _read_all()
            entry = _day_entry(data, today)
            entry["items"] = suggestions + entry["items"]
            entry["generated_at"] = datetime.now().isoformat(timespec="seconds")
            _write_all(data)

    return load_focus(today)
