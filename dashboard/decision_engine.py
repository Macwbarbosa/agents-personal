#!/usr/bin/env python3
"""
decision_engine.py - Motor de decisao do Sr. Bazinga.

Transforma dados brutos de Bitrix, Outlook, Gmail e Calendar em
DecisionItems normalizados, priorizados e agrupados por contexto.

Cada item responde:
- O que merece atencao agora?
- Por que apareceu?
- Qual o proximo passo?
- Qual o tipo de acao (responder, executar, decidir, delegar, acompanhar)?
"""

from __future__ import annotations

import hashlib
from datetime import datetime, date, timedelta, timezone
from typing import Any


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _today() -> date:
    return date.today()


def _parse_dt(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _days_ago(dt: datetime | None) -> int | None:
    if not dt:
        return None
    now = _now()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt).days


def _days_until(dt: datetime | None) -> int | None:
    if not dt:
        return None
    now = _now()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt - now).days


def _hours_until(dt: datetime | None) -> float | None:
    if not dt:
        return None
    now = _now()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt - now).total_seconds() / 3600


def _short_id(*parts: str) -> str:
    raw = "|".join(str(p) for p in parts)
    return hashlib.md5(raw.encode()).hexdigest()[:10]


def _horizon(dt: datetime | None) -> str:
    if not dt:
        return "later"
    today = _today()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    d = dt.date() if hasattr(dt, "date") else dt
    if d <= today:
        return "now"
    if d == today + timedelta(days=1):
        return "today"
    if d <= today + timedelta(days=7):
        return "week"
    return "later"


def _compute_urgency(item: dict) -> int:
    """Calcula score de urgencia baseado em heuristicas."""
    score = 0
    horizon = item.get("horizon", "later")
    action = item.get("actionType", "")

    # Horizonte de tempo
    if horizon == "now":
        score += 40
    elif horizon == "today":
        score += 30
    elif horizon == "week":
        score += 10

    # Tipo de acao
    if action == "respond":
        score += 5
    elif action == "execute":
        score += 3

    # Reuniao proxima
    meeting_hours = item.get("_meeting_hours")
    if meeting_hours is not None and meeting_hours < 3:
        score += 25
    elif meeting_hours is not None and meeting_hours < 24:
        score += 10

    # Quick win
    effort = item.get("effortMinutes")
    if effort and effort <= 10:
        score += 10
    elif effort and effort <= 30:
        score += 3

    # Risco
    if item.get("riskLevel") == "high":
        score += 20
    elif item.get("riskLevel") == "medium":
        score += 8

    # Age (email antigo)
    age_days = item.get("_age_days")
    if age_days and age_days > 5:
        score += 15
    elif age_days and age_days > 2:
        score += 8

    # Flagged/importante
    if item.get("_flagged"):
        score += 15

    return score


# ============================================================
# Builders: cada funcao converte uma fonte em DecisionItems
# ============================================================

def _items_from_bitrix(tasks: dict) -> list[dict]:
    items = []
    today = _today()
    for task in tasks.get("items", []) or []:
        if task.get("done"):
            continue
        task_id = task.get("id")
        title = (task.get("title") or f"Tarefa #{task_id}").strip()
        deadline_dt = _parse_dt(task.get("deadline", ""))
        deadline_day = deadline_dt.date() if deadline_dt else None

        # Determine horizon and why
        why_now = []
        horizon = "later"
        risk = "low"
        action_type = "execute"

        if deadline_day and deadline_day < today:
            days_late = (today - deadline_day).days
            horizon = "now"
            risk = "high"
            why_now.append(f"Atrasada ha {days_late} dia{'s' if days_late > 1 else ''}")
        elif deadline_day and deadline_day == today:
            horizon = "today"
            risk = "medium"
            why_now.append("Prazo vence hoje")
        elif deadline_day and deadline_day <= today + timedelta(days=2):
            horizon = "today"
            why_now.append(f"Prazo em {(deadline_day - today).days} dia{'s' if (deadline_day - today).days > 1 else ''}")
        elif deadline_day and deadline_day <= today + timedelta(days=7):
            horizon = "week"
            why_now.append(f"Prazo em {(deadline_day - today).days} dias")

        if not why_now:
            why_now.append("Tarefa aberta sem prazo definido")

        # Next best action
        status = (task.get("status_label") or "").lower()
        if "fazer" in status or "nova" in status:
            next_action = "Iniciar execucao"
        elif "andamento" in status or "em progresso" in status:
            next_action = "Continuar execucao"
        else:
            next_action = "Verificar status e avancar"

        group = task.get("group_name") or ""
        context_title = group if group else title[:50]

        items.append({
            "id": f"btx-{task_id}",
            "contextId": f"bitrix-{task_id}",
            "contextTitle": context_title,
            "title": title,
            "actionType": action_type,
            "horizon": horizon,
            "whyNow": why_now,
            "nextBestAction": next_action,
            "effortMinutes": 30,
            "riskLevel": risk,
            "sources": ["bitrix"],
            "dueDate": task.get("deadline"),
            "url": task.get("url"),
            "statusLabel": task.get("status_label"),
            "groupName": group,
            "responsibleName": task.get("responsible_name"),
            "_raw_type": "bitrix",
            "_raw_id": task_id,
        })
    return items


def _items_from_emails(outlook_inbox: list, gmail_inbox: list) -> list[dict]:
    items = []

    for mail in outlook_inbox or []:
        if not mail.get("unread") and not mail.get("flagged"):
            continue
        mail_id = mail.get("id", "")
        subject = (mail.get("subject") or "(sem assunto)").strip()
        sender = (mail.get("from_name") or mail.get("from_email") or "remetente").strip()
        received_dt = _parse_dt(mail.get("received", ""))
        age = _days_ago(received_dt)

        why_now = []
        horizon = "today"
        risk = "low"
        effort = 10

        if mail.get("flagged"):
            why_now.append("Marcado com flag no Outlook")
            risk = "medium"
        if age and age > 5:
            why_now.append(f"Sem resposta ha {age} dias")
            risk = "medium"
            horizon = "now"
        elif age and age > 2:
            why_now.append(f"Recebido ha {age} dias")
            horizon = "now"
        elif age and age >= 1:
            why_now.append("Recebido ontem")
        else:
            why_now.append("Recebido hoje")

        if not why_now:
            why_now.append("Email nao lido")

        items.append({
            "id": f"ol-{_short_id(mail_id)}",
            "contextId": f"email-{_short_id(sender, subject[:30])}",
            "contextTitle": sender,
            "title": subject,
            "actionType": "respond",
            "horizon": horizon,
            "whyNow": why_now,
            "nextBestAction": "Ler e responder",
            "effortMinutes": effort,
            "riskLevel": risk,
            "sources": ["email"],
            "sourceDetail": "outlook",
            "_raw_type": "outlook",
            "_raw_id": mail_id,
            "_age_days": age,
            "_flagged": mail.get("flagged", False),
            "preview": mail.get("preview") or mail.get("subject", ""),
        })

    for mail in gmail_inbox or []:
        if not mail.get("unread"):
            continue
        mail_id = mail.get("id", "")
        subject = (mail.get("subject") or "(sem assunto)").strip()
        sender_raw = mail.get("from") or "remetente"
        sender = sender_raw.split("<")[0].strip() or sender_raw
        mail_dt = _parse_dt(mail.get("date", ""))
        age = _days_ago(mail_dt)

        why_now = []
        horizon = "today"
        risk = "low"

        if age and age > 5:
            why_now.append(f"Sem resposta ha {age} dias")
            risk = "medium"
            horizon = "now"
        elif age and age > 2:
            why_now.append(f"Recebido ha {age} dias")
            horizon = "now"
        elif age and age >= 1:
            why_now.append("Recebido ontem")
        else:
            why_now.append("Recebido hoje")

        items.append({
            "id": f"gm-{_short_id(mail_id)}",
            "contextId": f"email-{_short_id(sender, subject[:30])}",
            "contextTitle": sender,
            "title": subject,
            "actionType": "respond",
            "horizon": horizon,
            "whyNow": why_now,
            "nextBestAction": "Ler e responder",
            "effortMinutes": 10,
            "riskLevel": risk,
            "sources": ["email"],
            "sourceDetail": "gmail",
            "_raw_type": "gmail",
            "_raw_id": mail_id,
            "_age_days": age,
            "_flagged": False,
            "preview": mail.get("snippet") or mail.get("subject", ""),
        })

    return items


def _items_from_calendar(m365_events: list, google_events: list) -> list[dict]:
    items = []
    today = _today()

    for ev in (m365_events or []) + (google_events or []):
        start_dt = _parse_dt(ev.get("start", ""))
        end_dt = _parse_dt(ev.get("end", ""))
        if not start_dt:
            continue

        ev_date = start_dt.date()
        if ev_date < today:
            continue

        # Only meetings >= 30min are "decision" items
        duration_min = 0
        if end_dt:
            duration_min = (end_dt - start_dt).total_seconds() / 60

        if duration_min < 30 and ev_date == today:
            # Short events still show in agenda but not as decision items
            continue

        title = (ev.get("title") or "Reuniao").strip()
        hours_away = _hours_until(start_dt)
        ev_id = ev.get("id") or _short_id(title, ev.get("start", ""))

        why_now = []
        horizon = "later"
        action_type = "decide"

        if ev_date == today:
            horizon = "today"
            if hours_away is not None and hours_away < 1:
                why_now.append("Comeca em menos de 1 hora")
                horizon = "now"
            elif hours_away is not None and hours_away < 3:
                why_now.append(f"Comeca em {int(hours_away)}h")
            else:
                why_now.append("Reuniao hoje")
        elif ev_date == today + timedelta(days=1):
            horizon = "today"
            why_now.append("Reuniao amanha — preparar")
        elif ev_date <= today + timedelta(days=7):
            horizon = "week"
            days_until = (ev_date - today).days
            why_now.append(f"Reuniao em {days_until} dias")

        attendees = [a.get("name") or a.get("email", "") for a in ev.get("attendees") or []]

        items.append({
            "id": f"cal-{_short_id(ev_id)}",
            "contextId": f"meeting-{_short_id(title)}",
            "contextTitle": title,
            "title": title,
            "actionType": action_type,
            "horizon": horizon,
            "whyNow": why_now,
            "nextBestAction": "Revisar pauta e preparar" if hours_away and hours_away > 1 else "Entrar na reuniao",
            "effortMinutes": int(duration_min) if duration_min else None,
            "riskLevel": "low",
            "sources": ["calendar"],
            "meetingDate": ev.get("start"),
            "meetingEnd": ev.get("end"),
            "joinUrl": ev.get("join_url"),
            "location": ev.get("location"),
            "attendees": attendees[:5],
            "online": ev.get("online") or bool(ev.get("join_url")),
            "_raw_type": "calendar",
            "_raw_id": ev_id,
            "_meeting_hours": hours_away,
        })

    return items


def _items_from_sent(gmail_sent: list) -> list[dict]:
    """Emails enviados que podem estar aguardando resposta."""
    items = []
    for mail in (gmail_sent or [])[:10]:
        mail_id = mail.get("id", "")
        subject = (mail.get("subject") or "(sem assunto)").strip()
        to_raw = mail.get("to") or ""
        to_name = to_raw.split("<")[0].strip() or to_raw
        mail_dt = _parse_dt(mail.get("date", ""))
        age = _days_ago(mail_dt)

        if age is None or age < 2:
            continue  # Too recent to be a follow-up

        why_now = [f"Enviado ha {age} dias sem resposta"]

        items.append({
            "id": f"fu-{_short_id(mail_id)}",
            "contextId": f"followup-{_short_id(to_name, subject[:30])}",
            "contextTitle": to_name,
            "title": f"Follow-up: {subject}",
            "actionType": "follow_up",
            "horizon": "today" if age > 5 else "week",
            "whyNow": why_now,
            "nextBestAction": "Cobrar resposta",
            "effortMinutes": 5,
            "riskLevel": "medium" if age > 7 else "low",
            "sources": ["email"],
            "sourceDetail": "gmail",
            "waitingOn": to_name,
            "_raw_type": "gmail_sent",
            "_raw_id": mail_id,
            "_age_days": age,
        })

    return items


def _items_from_projects(projects: list) -> list[dict]:
    """Projetos parados (sem atividade > 7 dias)."""
    items = []
    now_ts = _now().timestamp()
    for p in projects or []:
        modified_dt = _parse_dt(p.get("modified", ""))
        if not modified_dt:
            continue
        days_stale = int((now_ts - modified_dt.timestamp()) / 86400)
        if days_stale < 7:
            continue

        items.append({
            "id": f"proj-{_short_id(p.get('slug', p.get('title', '')))}",
            "contextId": f"project-{p.get('slug', '')}",
            "contextTitle": p.get("title", "Projeto"),
            "title": f"Projeto parado: {p.get('title', '')}",
            "actionType": "follow_up",
            "horizon": "week",
            "whyNow": [f"Sem atividade ha {days_stale} dias"],
            "nextBestAction": "Revisar status e destravar",
            "effortMinutes": 15,
            "riskLevel": "high" if days_stale > 14 else "medium",
            "sources": ["bitrix"],
            "_raw_type": "project",
            "_raw_id": p.get("slug", ""),
        })

    return items


# ============================================================
# Briefing: resumo executivo do dia
# ============================================================

def _build_briefing(items: list[dict], all_events: list, snapshot: dict) -> dict:
    """Gera o briefing inteligente do topo."""
    today = _today()
    today_str = today.isoformat()

    # Count priorities
    priorities_today = [i for i in items if i.get("horizon") in ("now", "today") and i.get("urgencyScore", 0) >= 25]
    quick_responses = [i for i in items if i.get("actionType") == "respond" and i.get("effortMinutes", 99) <= 10]
    risks = [i for i in items if i.get("riskLevel") in ("high", "medium")]
    followups = [i for i in items if i.get("actionType") == "follow_up"]
    waiting = [i for i in items if i.get("waitingOn")]

    # Calculate free time today
    today_events = [e for e in all_events if (e.get("start") or "").startswith(today_str)]
    busy_minutes = 0
    for ev in today_events:
        start_dt = _parse_dt(ev.get("start", ""))
        end_dt = _parse_dt(ev.get("end", ""))
        if start_dt and end_dt:
            busy_minutes += max(0, (end_dt - start_dt).total_seconds() / 60)

    work_day_minutes = 8 * 60  # 8h workday
    free_minutes = max(0, work_day_minutes - busy_minutes)
    free_hours = int(free_minutes // 60)
    free_mins = int(free_minutes % 60)
    free_text = f"{free_hours}h{free_mins:02d}" if free_hours > 0 else f"{free_mins}min"

    # Build narrative
    parts = []
    if len(priorities_today) > 0:
        parts.append(f"{len(priorities_today)} prioridade{'s' if len(priorities_today) > 1 else ''} hoje")
    if len(quick_responses) > 0:
        parts.append(f"{len(quick_responses)} resposta{'s' if len(quick_responses) > 1 else ''} rapida{'s' if len(quick_responses) > 1 else ''}")
    high_risks = [r for r in risks if r.get("riskLevel") == "high"]
    if high_risks:
        parts.append(f"{len(high_risks)} risco{'s' if len(high_risks) > 1 else ''} ativo{'s' if len(high_risks) > 1 else ''}")
    if len(followups) > 0:
        parts.append(f"{len(followups)} follow-up{'s' if len(followups) > 1 else ''} pendente{'s' if len(followups) > 1 else ''}")

    summary = " · ".join(parts) if parts else "Dia tranquilo."

    # Build narrative sentence
    sentences = []
    if priorities_today:
        sentences.append(f"Hoje sua atencao vai para {len(priorities_today)} frente{'s' if len(priorities_today) > 1 else ''}.")
    if quick_responses:
        sentences.append(f"Ha {len(quick_responses)} resposta{'s' if len(quick_responses) > 1 else ''} que pode{'m' if len(quick_responses) > 1 else ''} sair em menos de 10 minutos.")
    if high_risks:
        sentences.append(f"{len(high_risks)} item{'s' if len(high_risks) > 1 else ''} em risco esta semana.")
    if not sentences:
        sentences.append("Nenhuma urgencia identificada. Bom momento para trabalho profundo.")

    return {
        "summary": summary,
        "narrative": " ".join(sentences),
        "counters": {
            "priorities": len(priorities_today),
            "quickResponses": len(quick_responses),
            "risks": len(high_risks),
            "followups": len(followups),
            "waiting": len(waiting),
            "freeTime": free_text,
            "freeMinutes": int(free_minutes),
            "meetings": len(today_events),
        },
        "focusSuggestion": None,  # Will be populated if there's free time
    }


# ============================================================
# Sidebar data
# ============================================================

def _build_sidebar(items: list[dict], all_events: list, snapshot: dict) -> dict:
    today = _today()
    today_str = today.isoformat()

    # Today's agenda (all events, not just 30min+)
    all_m365 = snapshot.get("m365_calendar") or []
    all_google = snapshot.get("calendar") or []
    today_events = []
    for ev in all_m365 + all_google:
        if (ev.get("start") or "").startswith(today_str):
            today_events.append(ev)
    today_events.sort(key=lambda e: e.get("start", ""))

    # Waiting on others
    waiting = [i for i in items if i.get("actionType") == "follow_up" and i.get("waitingOn")]

    # Risks this week
    risks = [i for i in items if i.get("riskLevel") in ("high", "medium")]

    # Meetings requiring prep (next 48h, >= 30min)
    prep_meetings = []
    for ev in all_m365 + all_google:
        start_dt = _parse_dt(ev.get("start", ""))
        end_dt = _parse_dt(ev.get("end", ""))
        if not start_dt:
            continue
        hours = _hours_until(start_dt)
        if hours is None or hours < 0 or hours > 48:
            continue
        if end_dt and (end_dt - start_dt).total_seconds() / 60 < 30:
            continue
        prep_meetings.append({
            "title": ev.get("title", ""),
            "start": ev.get("start", ""),
            "hoursUntil": round(hours, 1),
            "joinUrl": ev.get("join_url"),
            "attendees": [a.get("name") or a.get("email", "") for a in (ev.get("attendees") or [])][:5],
        })
    prep_meetings.sort(key=lambda m: m.get("hoursUntil", 99))

    return {
        "agenda": today_events,
        "waiting": waiting[:8],
        "risks": risks[:6],
        "prepMeetings": prep_meetings[:5],
    }


# ============================================================
# Main entry point
# ============================================================

def build_decision_items(snapshot: dict) -> dict:
    """
    Main function: takes a dashboard snapshot and returns
    the full decision-oriented view model.
    """
    bitrix = snapshot.get("bitrix_tasks") or {}
    outlook_inbox = snapshot.get("outlook_inbox") or []
    gmail_inbox = snapshot.get("emails_inbox") or []
    gmail_sent = snapshot.get("emails_sent") or []
    m365_cal = snapshot.get("m365_calendar") or []
    google_cal = snapshot.get("calendar") or []
    projects = snapshot.get("projects") or []

    # Build items from all sources
    all_items = []
    all_items.extend(_items_from_bitrix(bitrix))
    all_items.extend(_items_from_emails(outlook_inbox, gmail_inbox))
    all_items.extend(_items_from_calendar(m365_cal, google_cal))
    all_items.extend(_items_from_sent(gmail_sent))
    all_items.extend(_items_from_projects(projects))

    # Score and sort
    for item in all_items:
        item["urgencyScore"] = _compute_urgency(item)

    all_items.sort(key=lambda x: x.get("urgencyScore", 0), reverse=True)

    # Separate into categories
    priorities = [i for i in all_items if i.get("horizon") in ("now", "today") and i.get("urgencyScore", 0) >= 20][:5]
    priority_ids = {p["id"] for p in priorities}

    # Action queue = everything not in priorities
    queue = [i for i in all_items if i["id"] not in priority_ids]

    # Briefing
    all_events = m365_cal + google_cal
    briefing = _build_briefing(all_items, all_events, snapshot)

    # Sidebar
    sidebar = _build_sidebar(all_items, all_events, snapshot)

    # Clean internal fields before sending to frontend
    def clean(item: dict) -> dict:
        return {k: v for k, v in item.items() if not k.startswith("_")}

    return {
        "briefing": briefing,
        "priorities": [clean(i) for i in priorities],
        "queue": [clean(i) for i in queue],
        "sidebar": sidebar,
        "totalItems": len(all_items),
    }
