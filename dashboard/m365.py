#!/usr/bin/env python3
"""
m365.py - Cliente mínimo do Microsoft Graph para o dashboard.

Lê o cache MSAL gerado pelo ms-365-mcp-server (arquivo .token-cache.json),
extrai access_token, renova via refresh_token quando expirado e expõe:

  - fetch_outlook_inbox(top=15)
  - fetch_calendar_events(days_ahead=7)

Propositalmente isolado e read-only — nunca modifica dados no Microsoft 365.
"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOKEN_CACHE_PATH = Path(
    os.getenv(
        "MS365_MCP_TOKEN_CACHE_PATH",
        "/Users/mac/.npm/_npx/813b81b976932cb5/node_modules/@softeria/ms-365-mcp-server/.token-cache.json",
    )
)

# client_id do ms-365-mcp-server (public client, global cloud)
DEFAULT_CLIENT_ID = "084a3e9f-a9f4-43f7-89f9-d229cf97853e"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"

SCOPES = [
    "User.Read",
    "Mail.ReadWrite",
    "Calendars.ReadWrite",
    "offline_access",
]


# ---------- token cache ----------

def _read_cache() -> dict | None:
    if not TOKEN_CACHE_PATH.exists():
        return None
    try:
        envelope = json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    data = envelope.get("data") if isinstance(envelope, dict) else None
    if isinstance(data, str):
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            return None
    if isinstance(envelope, dict) and "AccessToken" in envelope:
        return envelope
    return None


def _write_cache(inner: dict) -> None:
    envelope = {
        "_cacheEnvelope": True,
        "data": json.dumps(inner, ensure_ascii=False),
        "savedAt": int(time.time() * 1000),
    }
    TOKEN_CACHE_PATH.write_text(
        json.dumps(envelope, ensure_ascii=False), encoding="utf-8"
    )


def _first(entry: dict) -> dict | None:
    if not isinstance(entry, dict) or not entry:
        return None
    return next(iter(entry.values()))


def _pick_access_token(cache: dict) -> tuple[str | None, int]:
    at = _first(cache.get("AccessToken") or {})
    if not at:
        return None, 0
    try:
        expires = int(at.get("expires_on") or 0)
    except (TypeError, ValueError):
        expires = 0
    return at.get("secret"), expires


def _pick_refresh_token(cache: dict) -> tuple[str | None, str | None]:
    rt = _first(cache.get("RefreshToken") or {})
    acc = _first(cache.get("Account") or {})
    if not rt:
        return None, None
    tenant = (acc or {}).get("realm") or "common"
    return rt.get("secret"), tenant


def _refresh_token(cache: dict) -> str | None:
    """Renova o access_token via refresh_token. Salva de volta no cache."""
    refresh, tenant = _pick_refresh_token(cache)
    if not refresh:
        return None

    token_url = f"https://login.microsoftonline.com/{tenant or 'common'}/oauth2/v2.0/token"
    body = urllib.parse.urlencode({
        "client_id": DEFAULT_CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "scope": " ".join(SCOPES),
    })

    try:
        result = subprocess.run(
            [
                "curl", "--silent", "--show-error", "--location",
                "-H", "Content-Type: application/x-www-form-urlencoded",
                "-X", "POST", "-d", body, token_url,
            ],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"curl rc={result.returncode}")
        payload = json.loads(result.stdout)
    except Exception as e:
        print(f"[m365] refresh falhou: {e}")
        return None

    access = payload.get("access_token")
    if not access:
        print(f"[m365] refresh sem access_token: {payload.get('error_description', payload)}")
        return None

    # Atualiza cache em memória e em disco
    at_entry = _first(cache.get("AccessToken") or {})
    if at_entry:
        at_entry["secret"] = access
        at_entry["cached_at"] = str(int(time.time()))
        at_entry["expires_on"] = str(int(time.time()) + int(payload.get("expires_in") or 3600))
        at_entry["extended_expires_on"] = at_entry["expires_on"]

    new_refresh = payload.get("refresh_token")
    if new_refresh:
        rt_entry = _first(cache.get("RefreshToken") or {})
        if rt_entry:
            rt_entry["secret"] = new_refresh

    try:
        _write_cache(cache)
    except Exception as e:
        print(f"[m365] nao foi possivel regravar cache: {e}")

    return access


def get_access_token() -> str | None:
    cache = _read_cache()
    if not cache:
        return None
    token, expires_on = _pick_access_token(cache)
    if token and expires_on > int(time.time()) + 120:
        return token
    return _refresh_token(cache)


# ---------- Graph API ----------

def _graph_get(path: str, token: str, params: dict | None = None) -> dict:
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    url = f"{GRAPH_BASE}{path}{query}"
    result = subprocess.run(
        [
            "curl", "-g", "--silent", "--show-error", "--location",
            "-H", f"Authorization: Bearer {token}",
            "-H", "Accept: application/json",
            "-H", 'Prefer: outlook.timezone="America/Sao_Paulo"',
            url,
        ],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"curl rc={result.returncode}")
    data = json.loads(result.stdout)
    if isinstance(data, dict) and "error" in data and isinstance(data["error"], dict):
        raise RuntimeError(data["error"].get("message") or "Graph error")
    return data


def fetch_outlook_inbox(top: int = 15) -> list[dict]:
    token = get_access_token()
    if not token:
        return []
    try:
        data = _graph_get(
            "/me/mailFolders/inbox/messages",
            token,
            {
                "$top": str(top),
                "$select": "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,bodyPreview,webLink,importance,conversationId",
                "$orderby": "receivedDateTime desc",
            },
        )
    except Exception as e:
        print(f"[m365] inbox falhou: {e}")
        return []

    messages = []
    for m in data.get("value", []) or []:
        sender = (m.get("from") or {}).get("emailAddress") or {}
        to_list = [
            (r.get("emailAddress") or {}).get("address", "")
            for r in (m.get("toRecipients") or [])
        ]
        cc_list = [
            (r.get("emailAddress") or {}).get("address", "")
            for r in (m.get("ccRecipients") or [])
        ]
        flag = (m.get("flag") or {}).get("flagStatus", "notFlagged")
        messages.append({
            "id": m.get("id"),
            "subject": m.get("subject") or "(sem assunto)",
            "from_name": sender.get("name") or "",
            "from_email": sender.get("address") or "",
            "to": to_list,
            "cc": cc_list,
            "received": m.get("receivedDateTime"),
            "unread": not m.get("isRead", False),
            "flagged": flag == "flagged",
            "preview": (m.get("bodyPreview") or "").strip(),
            "web_link": m.get("webLink") or "",
            "importance": m.get("importance") or "normal",
            "conversation_id": m.get("conversationId") or "",
            "source": "outlook",
        })
    return messages


def fetch_calendar_events(days_ahead: int = 7) -> list[dict]:
    token = get_access_token()
    if not token:
        return []
    now = datetime.now(timezone.utc)
    start = now.isoformat()
    end = (now + timedelta(days=days_ahead)).isoformat()

    try:
        data = _graph_get(
            "/me/calendarView",
            token,
            {
                "startDateTime": start,
                "endDateTime": end,
                "$top": "50",
                "$select": "id,subject,start,end,location,attendees,organizer,isOnlineMeeting,onlineMeeting,bodyPreview,webLink,showAs",
                "$orderby": "start/dateTime",
            },
        )
    except Exception as e:
        print(f"[m365] calendar falhou: {e}")
        return []

    events = []
    for ev in data.get("value", []) or []:
        start_obj = ev.get("start") or {}
        end_obj = ev.get("end") or {}
        loc = (ev.get("location") or {}).get("displayName") or ""
        online = ev.get("isOnlineMeeting", False)
        join_url = ((ev.get("onlineMeeting") or {}).get("joinUrl")) or ""
        attendees = [
            {
                "name": ((a.get("emailAddress") or {}).get("name") or ""),
                "email": ((a.get("emailAddress") or {}).get("address") or ""),
                "response": (a.get("status") or {}).get("response", ""),
            }
            for a in (ev.get("attendees") or [])
        ]
        organizer = ((ev.get("organizer") or {}).get("emailAddress") or {})
        events.append({
            "id": ev.get("id"),
            "title": ev.get("subject") or "(sem título)",
            "start": start_obj.get("dateTime"),
            "start_tz": start_obj.get("timeZone"),
            "end": end_obj.get("dateTime"),
            "end_tz": end_obj.get("timeZone"),
            "location": loc,
            "online": bool(online),
            "join_url": join_url,
            "organizer_name": organizer.get("name") or "",
            "organizer_email": organizer.get("address") or "",
            "attendees": attendees,
            "preview": (ev.get("bodyPreview") or "").strip(),
            "web_link": ev.get("webLink") or "",
            "show_as": ev.get("showAs") or "",
            "source": "outlook",
        })
    return events


def fetch_me() -> dict:
    token = get_access_token()
    if not token:
        return {}
    try:
        return _graph_get("/me", token)
    except Exception as e:
        print(f"[m365] /me falhou: {e}")
        return {}


if __name__ == "__main__":
    me = fetch_me()
    print("me:", me.get("displayName"), me.get("userPrincipalName"))
    inbox = fetch_outlook_inbox(top=5)
    print(f"inbox: {len(inbox)} mensagens")
    for m in inbox[:3]:
        print(f"  - [{'U' if m['unread'] else ' '}] {m['from_name']}: {m['subject']}")
    events = fetch_calendar_events(days_ahead=7)
    print(f"calendar: {len(events)} eventos")
    for e in events[:5]:
        print(f"  - {e['start']} {e['title']}")
