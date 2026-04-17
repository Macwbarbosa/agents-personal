/* ========= Sr. Bazinga — Decision-Oriented Dashboard ========= */

const API_BOOTSTRAP = "/api/bootstrap";
const API_SYNC = "/api/sync";
const API_DECISION = "/api/decision-items";
const API_FOCUS = "/api/focus";
const API_FOCUS_SUGGEST = "/api/focus/suggest";
const API_FOCUS_TOGGLE = "/api/focus/toggle";
const API_FOCUS_REMOVE = "/api/focus/remove";
const API_FOCUS_MIGRATE = "/api/focus/migrate";
const API_BITRIX_ACCESS = "/api/bitrix/access";
const API_BITRIX_UPDATE = "/api/bitrix/update";
const API_BITRIX_ACTION = "/api/bitrix/action";
const API_EMAIL_REPLY = "/api/email/reply";
const API_EMAIL_SEND = "/api/email/send";
const API_OUTLOOK_MESSAGE = "/api/outlook/message";
const API_OUTLOOK_REPLY = "/api/outlook/reply";
const API_EMAIL_SUGGEST_REPLY = "/api/email/suggest-reply";

const $ = (id) => document.getElementById(id);
let decisionData = null;
let currentFocusData = null;
let currentFilter = "all";
let queueShowAll = false;
let activeEmailModal = null;
let bitrixPayloadCache = null;
const bitrixAccessCache = {};
const bitrixAccessPending = new Set();
const emailCache = { inbox: {}, sent: {} };

/* ---------- Utilities ---------- */

function escapeHTML(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function fmtDateOnly(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return iso; }
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isPastDate(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  return !isNaN(d) && d.getTime() < Date.now();
}

function textToHTML(text) {
  return escapeHTML(text || "").replace(/\n/g, "<br>");
}

function setToday() {
  const now = new Date();
  const txt = now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("today").textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
}

function setGreeting() {
  const h = new Date().getHours();
  let g = h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  $("greeting").textContent = `${g}, Mac`;
}

async function postJSON(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  let data = null;
  try { data = await r.json(); } catch { data = { ok: false, error: `Resposta invalida em ${url}` }; }
  if (!r.ok || !data.ok) throw new Error(data?.error || `Falha na chamada ${url}`);
  return data;
}

function empty(msg) {
  return `<div class="empty">${msg}</div>`;
}

/* ---------- ACTION TYPE labels ---------- */

const ACTION_LABELS = {
  respond: "Responder",
  execute: "Executar",
  decide: "Decidir",
  follow_up: "Acompanhar",
  delegate: "Delegar",
};

function actionLabel(type) {
  return ACTION_LABELS[type] || type;
}

/* ========= BRIEFING ========= */

function renderBriefing(briefing) {
  if (!briefing) return;
  const { summary, narrative, counters } = briefing;

  $("briefing-summary").textContent = summary || "Carregando...";
  $("briefing-narrative").textContent = narrative || "";

  const c = counters || {};
  const chips = [];
  if (c.priorities > 0) chips.push({ icon: "!", text: `${c.priorities} prioridade${c.priorities > 1 ? "s" : ""}` });
  if (c.quickResponses > 0) chips.push({ icon: "\u21A9", text: `${c.quickResponses} resposta${c.quickResponses > 1 ? "s" : ""} rapida${c.quickResponses > 1 ? "s" : ""}` });
  if (c.risks > 0) chips.push({ icon: "\u26A0", text: `${c.risks} risco${c.risks > 1 ? "s" : ""}` });
  if (c.followups > 0) chips.push({ icon: "\u2709", text: `${c.followups} follow-up${c.followups > 1 ? "s" : ""}` });
  if (c.freeTime) chips.push({ icon: "\u23F0", text: `${c.freeTime} livres para foco` });
  if (c.meetings > 0) chips.push({ icon: "\u{1F4C5}", text: `${c.meetings} reunio${c.meetings > 1 ? "es" : ""}` });

  $("briefing-counters").innerHTML = chips.map(ch =>
    `<span class="briefing-chip"><span class="briefing-chip-icon">${ch.icon}</span>${escapeHTML(ch.text)}</span>`
  ).join("");
}

/* ========= PRIORITIES ========= */

function renderPriorities(priorities) {
  const list = $("priorities-list");
  const count = $("priorities-count");
  if (!list) return;

  if (!priorities || priorities.length === 0) {
    list.innerHTML = '<div class="queue-empty">Nenhuma prioridade critica identificada. Dia tranquilo.</div>';
    if (count) count.textContent = "";
    return;
  }

  if (count) count.textContent = `${priorities.length} item${priorities.length > 1 ? "s" : ""}`;

  list.innerHTML = priorities.map(item => {
    const riskClass = `risk-${item.riskLevel || "low"}`;
    const whyText = (item.whyNow || []).join(" · ");
    const sources = (item.sources || []).map(s =>
      `<span class="source-chip ${escapeHTML(s)}">${escapeHTML(s)}</span>`
    ).join("");
    const actionTag = `<span class="action-tag ${escapeHTML(item.actionType || "")}">${escapeHTML(actionLabel(item.actionType))}</span>`;

    // Quick action buttons
    let actions = "";
    if (item.actionType === "respond") {
      const isOutlook = item.sourceDetail === "outlook";
      const clickAttr = isOutlook
        ? `data-outlook-id="${escapeHTML(item._raw_id || "")}"`
        : `data-email-kind="inbox" data-email-id="${escapeHTML(item._raw_id || "")}"`;
      actions = `
        <div class="priority-actions">
          <button class="priority-action-btn primary" ${clickAttr}>Abrir e responder</button>
        </div>`;
    } else if (item.actionType === "execute" && item.url) {
      actions = `
        <div class="priority-actions">
          <a href="${escapeHTML(item.url)}" target="_blank" rel="noreferrer" class="priority-action-btn primary">Abrir no Bitrix</a>
        </div>`;
    } else if (item.actionType === "decide" && item.joinUrl) {
      actions = `
        <div class="priority-actions">
          <a href="${escapeHTML(item.joinUrl)}" target="_blank" rel="noreferrer" class="priority-action-btn primary">Entrar na reuniao</a>
        </div>`;
    }

    return `
      <div class="priority-card ${riskClass}">
        <div class="priority-top">
          <div>
            <div class="priority-context">${escapeHTML(item.contextTitle || "")}</div>
            <div class="priority-title">${escapeHTML(item.title)}</div>
          </div>
          ${actionTag}
        </div>
        <div class="priority-why">${escapeHTML(whyText)}</div>
        <div class="priority-meta">
          <span class="priority-next">${escapeHTML(item.nextBestAction || "")}</span>
          ${item.effortMinutes ? `<span class="priority-effort">~${item.effortMinutes}min</span>` : ""}
          <div class="priority-chips">${sources}</div>
        </div>
        ${actions}
      </div>
    `;
  }).join("");
}

/* ========= QUEUE (Fila de Acao) ========= */

function renderQueue(queue) {
  const list = $("queue-list");
  const count = $("queue-count");
  if (!list) return;

  let filtered = queue || [];
  if (currentFilter !== "all") {
    filtered = filtered.filter(i => i.actionType === currentFilter);
  }

  if (count) {
    const total = (queue || []).length;
    const shown = filtered.length;
    count.textContent = currentFilter === "all" ? `${total} item${total !== 1 ? "s" : ""}` : `${shown}/${total}`;
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="queue-empty">Nenhum item nesta fila.</div>';
    return;
  }

  const MAX_VISIBLE = 10;
  const visible = queueShowAll ? filtered : filtered.slice(0, MAX_VISIBLE);

  list.innerHTML = visible.map(item => {
    const dotClass = item.actionType || "execute";
    const why = (item.whyNow || [])[0] || "";
    const sources = (item.sources || []).map(s =>
      `<span class="source-chip ${escapeHTML(s)}">${escapeHTML(s)}</span>`
    ).join("");

    // Click behavior: emails open modal, bitrix open link
    let tag = "div";
    let clickAttr = "";
    if (item.actionType === "respond" && item._raw_type === "outlook") {
      tag = "button";
      clickAttr = `data-outlook-id="${escapeHTML(item._raw_id || "")}"`;
    } else if (item.actionType === "respond" && item._raw_type === "gmail") {
      tag = "button";
      clickAttr = `data-email-kind="inbox" data-email-id="${escapeHTML(item._raw_id || "")}"`;
    }

    return `
      <${tag} class="queue-item" ${clickAttr}>
        <div class="queue-dot ${escapeHTML(dotClass)}"></div>
        <div class="queue-body">
          <div class="queue-title">${escapeHTML(item.title)}</div>
          <div class="queue-sub">${escapeHTML(item.contextTitle || "")} ${sources}</div>
        </div>
        <div class="queue-meta">
          <span class="queue-why">${escapeHTML(why)}</span>
          <span class="action-tag ${escapeHTML(item.actionType || "")}">${escapeHTML(actionLabel(item.actionType))}</span>
        </div>
      </${tag}>
    `;
  }).join("");

  if (!queueShowAll && filtered.length > MAX_VISIBLE) {
    list.innerHTML += `
      <div class="queue-show-more">
        <button id="queue-show-more-btn">Ver todos (${filtered.length})</button>
      </div>
    `;
    const btn = $("queue-show-more-btn");
    if (btn) btn.addEventListener("click", () => { queueShowAll = true; renderQueue(queue); });
  }
}

/* ========= SIDEBAR ========= */

function renderSideAgenda(sidebar, briefing) {
  const el = $("side-agenda");
  if (!el) return;

  const events = sidebar?.agenda || [];
  if (events.length === 0) {
    const freeMin = briefing?.counters?.freeMinutes || 0;
    el.innerHTML = `
      <div class="side-free-time">
        <span class="side-free-time-icon">\u2728</span>
        <span class="side-free-time-text">Dia livre. ${freeMin > 120 ? "Otimo momento para trabalho profundo." : "Aproveite o tempo disponivel."}</span>
      </div>
    `;
    return;
  }

  let html = events.map(ev => {
    const time = fmtTime(ev.start);
    const joinLink = ev.join_url
      ? `<a class="side-agenda-join" href="${escapeHTML(ev.join_url)}" target="_blank" rel="noreferrer">Entrar</a>`
      : "";
    const onlineBadge = (ev.online || ev.join_url) ? '<span class="side-agenda-badge">Online</span>' : "";
    return `
      <div class="side-agenda-item">
        <div class="side-agenda-time">${escapeHTML(time)}</div>
        <div class="side-agenda-title">${escapeHTML(ev.title || "")}</div>
        ${onlineBadge}
        ${joinLink}
      </div>
    `;
  }).join("");

  // Free time indicator
  const freeMin = briefing?.counters?.freeMinutes || 0;
  if (freeMin > 30) {
    const freeText = briefing?.counters?.freeTime || "";
    html += `
      <div class="side-free-time">
        <span class="side-free-time-icon">\u23F0</span>
        <span class="side-free-time-text">${escapeHTML(freeText)} livres para foco</span>
      </div>
    `;
  }

  el.innerHTML = html;
}

function renderSideWaiting(sidebar) {
  const el = $("side-waiting");
  if (!el) return;
  const items = sidebar?.waiting || [];
  if (items.length === 0) {
    el.innerHTML = '<div class="side-empty">Nenhum follow-up pendente.</div>';
    return;
  }
  el.innerHTML = items.map(item => `
    <div class="side-item">
      <div class="side-dot orange"></div>
      <span class="side-item-text">${escapeHTML(item.waitingOn || item.contextTitle || "")}: ${escapeHTML(item.title || "")}</span>
      <span class="side-item-meta">${escapeHTML((item.whyNow || [])[0] || "")}</span>
    </div>
  `).join("");
}

function renderSideRisks(sidebar) {
  const el = $("side-risks");
  if (!el) return;
  const items = sidebar?.risks || [];
  if (items.length === 0) {
    el.innerHTML = '<div class="side-empty">Nenhum risco identificado.</div>';
    return;
  }
  el.innerHTML = items.map(item => {
    const dotColor = item.riskLevel === "high" ? "red" : "orange";
    return `
      <div class="side-item">
        <div class="side-dot ${dotColor}"></div>
        <span class="side-item-text">${escapeHTML(item.title || "")}</span>
        <span class="side-item-meta">${escapeHTML((item.whyNow || [])[0] || "")}</span>
      </div>
    `;
  }).join("");
}

function renderSidePrep(sidebar) {
  const el = $("side-prep");
  if (!el) return;
  const items = sidebar?.prepMeetings || [];
  if (items.length === 0) {
    el.innerHTML = '<div class="side-empty">Nenhuma reuniao proxima para preparar.</div>';
    return;
  }
  el.innerHTML = items.map(item => {
    const hours = item.hoursUntil;
    let timeLabel = "";
    if (hours < 1) timeLabel = "em <1h";
    else if (hours < 24) timeLabel = `em ${Math.round(hours)}h`;
    else timeLabel = fmtDate(item.start);
    const joinLink = item.joinUrl
      ? `<a class="side-agenda-join" href="${escapeHTML(item.joinUrl)}" target="_blank" rel="noreferrer">Entrar</a>`
      : "";
    return `
      <div class="side-item">
        <div class="side-dot purple"></div>
        <span class="side-item-text">${escapeHTML(item.title || "")}</span>
        <span class="side-item-meta">${escapeHTML(timeLabel)}</span>
        ${joinLink}
      </div>
    `;
  }).join("");
}

/* ========= FOCUS ========= */

async function loadFocus() {
  try {
    const resp = await fetch(`${API_FOCUS}?date=${todayISO()}`, { cache: "no-store" });
    const data = await resp.json();
    if (data.ok) currentFocusData = data.focus;
  } catch (e) { console.error("loadFocus:", e); }
}

function renderFocus() {
  const list = $("focus-list");
  if (!list) return;
  if (!currentFocusData || !currentFocusData.items || currentFocusData.items.length === 0) {
    list.innerHTML = '<div class="queue-empty">Nenhum foco definido. Clique "Sugerir" para gerar.</div>';
    return;
  }
  list.innerHTML = currentFocusData.items.map(item => {
    const age = item.age_tag ? `<span class="focus-age">${escapeHTML(item.age_tag)}</span>` : "";
    const source = item.source && item.source !== "manual"
      ? `<span class="focus-source">${escapeHTML(item.source.split(":")[0])}</span>`
      : "";
    return `
      <div class="focus-item${item.done ? " done" : ""}" data-focus-id="${escapeHTML(item.id)}">
        <input type="checkbox" class="focus-check" ${item.done ? "checked" : ""} data-focus-toggle="${escapeHTML(item.id)}">
        <span class="focus-text">${escapeHTML(item.text)}${age}</span>
        ${source}
        <button class="focus-remove" data-focus-remove="${escapeHTML(item.id)}" title="Remover">\u00D7</button>
      </div>
    `;
  }).join("");
}

async function handleFocusSuggest() {
  const btn = $("focus-suggest-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando..."; }
  try {
    await postJSON(API_FOCUS_MIGRATE, { date: todayISO() });
    const resp = await postJSON(API_FOCUS_SUGGEST, { date: todayISO() });
    if (resp.focus) currentFocusData = resp.focus;
    renderFocus();
  } catch (e) { console.error("suggest:", e); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "Sugerir"; } }
}

async function handleFocusToggle(focusId) {
  try {
    const resp = await postJSON(API_FOCUS_TOGGLE, { date: todayISO(), id: focusId });
    if (resp.focus) currentFocusData = resp.focus;
    renderFocus();
  } catch (e) { console.error("toggle:", e); }
}

async function handleFocusRemove(focusId) {
  try {
    const resp = await postJSON(API_FOCUS_REMOVE, { date: todayISO(), id: focusId });
    if (resp.focus) currentFocusData = resp.focus;
    renderFocus();
  } catch (e) { console.error("remove:", e); }
}

async function handleFocusAdd() {
  const input = $("focus-add-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  try {
    const resp = await postJSON(API_FOCUS, { date: todayISO(), text });
    if (resp.focus) currentFocusData = resp.focus;
    input.value = "";
    renderFocus();
  } catch (e) { console.error("add:", e); }
}

/* ========= SEMANA VIEW ========= */

let expandedSemanaDay = null;

function renderSemana(datasets) {
  const grid = $("semana-grid");
  if (!grid) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((dow + 6) % 7));

  const m365Events = datasets.m365_calendar || [];
  const googleEvents = datasets.calendar || [];
  const allEvents = [...m365Events, ...googleEvents];
  const tasks = ((datasets.bitrix_tasks || {}).items || []).filter(t => !t.done);
  const todayStr = todayISO();
  const dayNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];

  const cards = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const isToday = iso === todayStr;
    const dayEvents = allEvents.filter(e => (e.start || "").startsWith(iso));
    const dayTasks = tasks.filter(t => t.deadline && t.deadline.slice(0, 10) === iso);
    const overdueTasks = isToday ? tasks.filter(t => t.deadline && t.deadline.slice(0, 10) < iso) : [];
    const expanded = expandedSemanaDay === iso;

    let detail = "";
    if (expanded) {
      const detailItems = [];
      dayEvents.forEach(ev => detailItems.push(`<div class="semana-detail-item">${escapeHTML(fmtTime(ev.start))} ${escapeHTML(ev.title)}</div>`));
      dayTasks.forEach(t => detailItems.push(`<div class="semana-detail-item">${escapeHTML(t.title)}</div>`));
      overdueTasks.forEach(t => detailItems.push(`<div class="semana-detail-item" style="color:var(--red)">${escapeHTML(t.title)}</div>`));
      detail = detailItems.length > 0
        ? `<div class="semana-detail">${detailItems.join("")}</div>`
        : `<div class="semana-detail"><div class="side-empty">Dia livre</div></div>`;
    }

    cards.push(`
      <div class="semana-card${isToday ? " today" : ""}${expanded ? " expanded" : ""}" data-semana-day="${iso}">
        <div class="semana-day">${dayNames[d.getDay()]}</div>
        <div class="semana-date">${d.getDate()}</div>
        ${isToday ? '<div class="semana-today-label">Hoje</div>' : ""}
        <div class="semana-stats">
          ${dayEvents.length > 0 ? `<span>${dayEvents.length} evento${dayEvents.length > 1 ? "s" : ""}</span>` : ""}
          ${dayTasks.length > 0 ? `<span>${dayTasks.length} tarefa${dayTasks.length > 1 ? "s" : ""}</span>` : ""}
          ${overdueTasks.length > 0 ? `<span style="color:var(--red)">${overdueTasks.length} atrasada${overdueTasks.length > 1 ? "s" : ""}</span>` : ""}
          ${dayEvents.length === 0 && dayTasks.length === 0 && overdueTasks.length === 0 ? "<span>Livre</span>" : ""}
        </div>
        ${detail}
      </div>
    `);
  }

  grid.innerHTML = cards.join("");
}

/* ========= FILTERED SECTIONS (Respostas, Execucao, Aguardando) ========= */

function renderFilteredSection(sectionId, badgeId, listId, filterFn) {
  const list = $(listId);
  const badge = $(badgeId);
  if (!list || !decisionData) return;

  const allItems = [...(decisionData.priorities || []), ...(decisionData.queue || [])];
  const filtered = allItems.filter(filterFn);

  if (badge) badge.textContent = String(filtered.length);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="queue-empty">Nenhum item nesta categoria.</div>';
    return;
  }

  list.innerHTML = filtered.map(item => {
    const dotClass = item.actionType || "execute";
    const why = (item.whyNow || [])[0] || "";
    const sources = (item.sources || []).map(s =>
      `<span class="source-chip ${escapeHTML(s)}">${escapeHTML(s)}</span>`
    ).join("");

    return `
      <div class="queue-item">
        <div class="queue-dot ${escapeHTML(dotClass)}"></div>
        <div class="queue-body">
          <div class="queue-title">${escapeHTML(item.title)}</div>
          <div class="queue-sub">${escapeHTML(item.contextTitle || "")} ${sources}</div>
        </div>
        <div class="queue-meta">
          <span class="queue-why">${escapeHTML(why)}</span>
        </div>
      </div>
    `;
  }).join("");
}

/* ========= LEGACY SOURCE RENDERS ========= */

function cacheEmails(kind, emails) {
  emailCache[kind] = {};
  (emails || []).forEach(email => { if (email?.id) emailCache[kind][String(email.id)] = email; });
}

function renderMeta(meta) {
  if (!meta) {
    $("sync-status").textContent = "Sem dados";
    $("sync-status").className = "sync-status err";
    return;
  }
  if (meta.last_sync) {
    $("last-sync").textContent = `Sync: ${fmtDate(meta.last_sync)}`;
    $("sync-status").textContent = "Atualizado";
    $("sync-status").className = "sync-status ok";
  }
}

function renderEmails(emails) {
  const list = $("emails-list");
  if (!list) return;
  if (!emails || emails.length === 0) { list.innerHTML = empty("Inbox vazia."); $("emails-badge").textContent = "0"; return; }
  const unread = emails.filter(e => e.unread).length;
  $("emails-badge").textContent = unread;
  cacheEmails("inbox", emails);
  list.innerHTML = emails.map(e => {
    const fromName = (e.from || "").replace(/<.*>/, "").trim() || e.from;
    return `
      <button class="list-item list-item-button" type="button" data-email-kind="inbox" data-email-id="${escapeHTML(e.id || "")}">
        <div class="list-dot ${e.unread ? "orange" : "muted"}"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(e.subject || "(sem assunto)")}</div>
          <div class="list-sub">${escapeHTML(fromName)} · ${escapeHTML(e.snippet || "")}</div>
        </div>
        <div class="list-meta">${escapeHTML((e.date || "").split(" ").slice(0, 4).join(" "))}</div>
      </button>
    `;
  }).join("");
}

function renderEmailsSent(emails) {
  const list = $("emails-sent-list");
  if (!list) return;
  if (!emails || emails.length === 0) { list.innerHTML = empty("Nenhum enviado."); return; }
  cacheEmails("sent", emails);
  list.innerHTML = emails.map(e => {
    const toName = (e.to || "").replace(/<.*>/, "").trim() || e.to;
    return `
      <button class="list-item list-item-button" type="button" data-email-kind="sent" data-email-id="${escapeHTML(e.id || "")}">
        <div class="list-dot blue"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(e.subject || "(sem assunto)")}</div>
          <div class="list-sub">\u2192 ${escapeHTML(toName)} · ${escapeHTML(e.snippet || "")}</div>
        </div>
        <div class="list-meta">${escapeHTML((e.date || "").split(" ").slice(0, 4).join(" "))}</div>
      </button>
    `;
  }).join("");
}

function renderCalendar(events) {
  const list = $("calendar-list");
  if (!list) return;
  if (!events || events.length === 0) { list.innerHTML = empty("Nenhum compromisso."); $("calendar-badge").textContent = "0"; return; }
  $("calendar-badge").textContent = events.length;
  const today = todayISO();
  list.innerHTML = events.map(e => {
    const isToday = (e.start || "").startsWith(today);
    return `
      <div class="list-item">
        <div class="list-dot ${isToday ? "green" : "blue"}"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(e.title)}</div>
          <div class="list-sub">${escapeHTML(e.location || "Sem local")}</div>
        </div>
        <div class="list-meta">${escapeHTML(fmtDate(e.start))}</div>
      </div>
    `;
  }).join("");
}

function renderProjects(projects) {
  const list = $("projects-list");
  if (!list) return;
  if (!projects || projects.length === 0) { list.innerHTML = empty("Nenhum projeto."); $("projects-badge").textContent = "0"; return; }
  $("projects-badge").textContent = projects.length;
  const colors = ["", "orange", "green", "blue"];
  list.innerHTML = projects.map((p, i) => {
    const initials = (p.title || "P").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-avatar ${colors[i % colors.length]}">${escapeHTML(initials)}</div>
          <div><div class="card-title">${escapeHTML(p.title)}</div><div class="card-role">${escapeHTML(p.slug)}</div></div>
        </div>
        <div class="card-body">${escapeHTML(p.description || "Sem descricao")}</div>
        <div class="card-footer"><span><span class="status-dot"></span>ativo</span><span>${fmtDateOnly(p.modified)}</span></div>
      </div>
    `;
  }).join("");
}

function renderBitrix(payload) {
  bitrixPayloadCache = payload;
  const list = $("bitrix-list");
  const badge = $("bitrix-badge");
  if (!list) return;
  if (!payload || !payload.configured) { badge.textContent = "0"; list.innerHTML = empty("Bitrix nao configurado."); return; }
  if (payload.error) { badge.textContent = "!"; list.innerHTML = empty(`Falha: ${escapeHTML(payload.error)}`); return; }
  const tasks = Array.isArray(payload.items) ? payload.items : [];
  const openCount = payload.open_count ?? tasks.filter(t => !t.done).length;
  badge.textContent = String(openCount);
  if (tasks.length === 0) { list.innerHTML = empty("Nenhuma tarefa."); return; }

  list.innerHTML = tasks.slice(0, 20).map(task => {
    const access = bitrixAccessCache[String(task.id)] || null;
    const overdue = !task.done && isPastDate(task.deadline);
    const dotClass = task.done ? "green" : overdue ? "red" : "blue";
    const title = escapeHTML(task.title || `Tarefa #${task.id || "?"}`);
    const link = task.url ? `<a class="list-link" href="${escapeHTML(task.url)}" target="_blank" rel="noreferrer">${title}</a>` : title;
    const metaPieces = [];
    if (task.status_label) metaPieces.push(`<span class="list-tag">${escapeHTML(task.status_label)}</span>`);
    if (task.group_name) metaPieces.push(`<span class="list-tag">${escapeHTML(task.group_name)}</span>`);
    if (overdue) metaPieces.push(`<span class="list-tag red">Atrasada</span>`);
    const dateLabel = task.done ? "Concluida" : task.deadline ? `Prazo ${fmtDate(task.deadline)}` : "";
    const canStart = !task.done && (access?.start || access?.changeStatus);
    const canComplete = !task.done && access?.complete;
    const canDefer = !task.done && access?.defer;
    const canRenew = task.done && access?.renew;

    return `
      <div class="list-item bitrix-item${task.done ? " done" : ""}" data-task-id="${escapeHTML(task.id)}">
        <div class="list-dot ${dotClass}"></div>
        <div class="list-body">
          <div class="list-title">${link}</div>
          <div class="list-sub">${metaPieces.join("")}</div>
          <div class="bitrix-controls">
            <div class="bitrix-form-row bitrix-actions-row">
              <button class="bitrix-btn" data-bitrix-action="start" ${canStart ? "" : "disabled"}>Iniciar</button>
              <button class="bitrix-btn warning" data-bitrix-action="defer" ${canDefer ? "" : "disabled"}>Adiar</button>
              <button class="bitrix-btn success" data-bitrix-action="complete" ${canComplete ? "" : "disabled"}>Concluir</button>
              <button class="bitrix-btn" data-bitrix-action="renew" ${canRenew ? "" : "disabled"}>Reabrir</button>
            </div>
            <div class="bitrix-feedback" data-task-id="${escapeHTML(task.id)}"></div>
          </div>
        </div>
        <div class="list-meta">${escapeHTML(dateLabel)}</div>
      </div>
    `;
  }).join("");
}

/* ========= EMAIL MODAL (preserved) ========= */

function ensureEmailReplyUI() {
  const modalCard = document.querySelector("#email-modal .modal-card");
  if (!modalCard) return false;
  return Boolean($("email-reply-box") && $("email-reply-input") && $("email-reply-send") && $("email-reply-all-send"));
}

function openEmailModal(kind, emailId) {
  const email = emailCache[kind]?.[String(emailId)];
  if (!email) return;
  ensureEmailReplyUI();
  const modal = $("email-modal");
  const subject = $("email-modal-subject");
  const meta = $("email-modal-meta");
  const bodyEl = $("email-modal-body");
  if (!modal || !subject || !meta || !bodyEl) return;
  activeEmailModal = { kind, email };
  subject.textContent = email.subject || "(sem assunto)";
  const metaParts = [];
  if (kind === "sent") metaParts.push(`Para: ${email.to || "\u2014"}`);
  else metaParts.push(`De: ${email.from || "\u2014"}`);
  if (email.date) metaParts.push(email.date);
  meta.textContent = metaParts.join(" \u00B7 ");
  const body = email.body_text || email.snippet || "Sem conteudo.";
  bodyEl.innerHTML = textToHTML(body);
  const replyBox = $("email-reply-box");
  const replyInput = $("email-reply-input");
  const canReply = kind === "inbox";
  if (replyBox) {
    replyBox.classList.toggle("hidden", !canReply);
    if (replyInput) replyInput.value = "";
    const fb = $("email-reply-feedback");
    if (fb) { fb.textContent = ""; fb.className = "email-reply-feedback"; }
    if (canReply) {
      const rt = $("email-reply-target");
      if (rt) rt.textContent = email.reply_to || email.from || "";
      window.setTimeout(() => { if (replyInput) replyInput.focus(); }, 40);
    }
  }
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

async function openOutlookEmailModal(outlookId) {
  const modal = $("email-modal");
  const subject = $("email-modal-subject");
  const meta = $("email-modal-meta");
  const bodyEl = $("email-modal-body");
  if (!modal || !subject || !meta || !bodyEl) return;
  ensureEmailReplyUI();
  subject.textContent = "Carregando...";
  meta.textContent = "";
  bodyEl.innerHTML = '<div class="empty">Buscando email do Outlook...</div>';
  const replyBox = $("email-reply-box");
  if (replyBox) replyBox.classList.add("hidden");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  activeEmailModal = { kind: "outlook", email: null };
  try {
    const resp = await postJSON(API_OUTLOOK_MESSAGE, { id: outlookId });
    const email = resp.message;
    activeEmailModal = { kind: "outlook", email };
    subject.textContent = email.subject || "(sem assunto)";
    const metaParts = [`De: ${email.from || "\u2014"}`];
    if (email.date) metaParts.push(fmtDate(email.date));
    if (email.to) metaParts.push(`Para: ${email.to}`);
    meta.textContent = metaParts.join(" \u00B7 ");
    if (email.body_type === "html") {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "width:100%;border:none;min-height:300px;";
      iframe.sandbox = "allow-same-origin";
      bodyEl.innerHTML = "";
      bodyEl.appendChild(iframe);
      iframe.contentDocument.open();
      iframe.contentDocument.write(`<html><head><style>body{font-family:-apple-system,sans-serif;font-size:14px;color:#1a1d29;line-height:1.6;margin:12px;}</style></head><body>${email.body_text}</body></html>`);
      iframe.contentDocument.close();
      const resizeIframe = () => { try { iframe.style.height = iframe.contentDocument.body.scrollHeight + 20 + "px"; } catch {} };
      iframe.onload = resizeIframe;
      setTimeout(resizeIframe, 200);
    } else {
      bodyEl.innerHTML = textToHTML(email.body_text || "Sem conteudo.");
    }
    if (replyBox) {
      replyBox.classList.remove("hidden");
      const replyInput = $("email-reply-input");
      if (replyInput) replyInput.value = "";
      const fb = $("email-reply-feedback");
      if (fb) { fb.textContent = ""; fb.className = "email-reply-feedback"; }
      const rt = $("email-reply-target");
      if (rt) rt.textContent = email.reply_to || email.from_email || email.from || "";
      window.setTimeout(() => { if (replyInput) replyInput.focus(); }, 40);
    }
  } catch (err) {
    subject.textContent = "Erro ao carregar";
    bodyEl.innerHTML = `<div class="empty">${escapeHTML(err.message || "Falha.")}</div>`;
  }
}

function closeEmailModal() {
  activeEmailModal = null;
  const modal = $("email-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

async function sendEmailReplyMode(replyAll) {
  if (!activeEmailModal?.email) return;
  const kind = activeEmailModal.kind;
  if (kind !== "inbox" && kind !== "outlook") return;
  const replyInput = $("email-reply-input");
  const replyFeedback = $("email-reply-feedback");
  const replyButton = $("email-reply-send");
  const replyAllButton = $("email-reply-all-send");
  if (!replyInput || !replyFeedback || !replyButton || !replyAllButton) return;
  const replyText = replyInput.value.trim();
  if (!replyText) { replyFeedback.textContent = "Escreva a resposta."; replyFeedback.className = "email-reply-feedback err"; replyInput.focus(); return; }
  try {
    replyButton.disabled = true; replyAllButton.disabled = true;
    replyFeedback.textContent = "Enviando..."; replyFeedback.className = "email-reply-feedback";
    if (kind === "outlook") await postJSON(API_OUTLOOK_REPLY, { id: activeEmailModal.email.id, reply_text: replyText });
    else await postJSON(API_EMAIL_REPLY, { original_email: activeEmailModal.email, reply_text: replyText, reply_all: replyAll });
    replyInput.value = "";
    replyFeedback.textContent = replyAll ? "Resposta para todos enviada." : "Resposta enviada.";
    replyFeedback.className = "email-reply-feedback ok";
    await loadAll();
  } catch (error) {
    replyFeedback.textContent = error.message || "Falha.";
    replyFeedback.className = "email-reply-feedback err";
  } finally {
    replyButton.disabled = false; replyAllButton.disabled = false;
  }
}

async function handleSuggestReply() {
  if (!activeEmailModal?.email) return;
  const email = activeEmailModal.email;
  const replyInput = $("email-reply-input");
  const replyFeedback = $("email-reply-feedback");
  const suggestBtn = $("email-suggest-btn");
  if (!replyInput || !replyFeedback || !suggestBtn) return;
  try {
    suggestBtn.disabled = true; suggestBtn.textContent = "Gerando...";
    replyFeedback.textContent = "Solicitando sugestao..."; replyFeedback.className = "email-reply-feedback";
    const bodyText = email.body_text || email.snippet || email.preview || "";
    const sender = email.from_name || email.from || email.from_email || "";
    const resp = await postJSON(API_EMAIL_SUGGEST_REPLY, { subject: email.subject || "", sender, body: bodyText.slice(0, 4000) });
    if (resp.suggestion) { replyInput.value = resp.suggestion; replyFeedback.textContent = "Sugestao gerada. Revise antes de enviar."; replyFeedback.className = "email-reply-feedback ok"; replyInput.focus(); }
  } catch (error) { replyFeedback.textContent = error.message || "Falha."; replyFeedback.className = "email-reply-feedback err"; }
  finally { suggestBtn.disabled = false; suggestBtn.textContent = "Sugerir resposta"; }
}

function openComposeModal() {
  const modal = $("compose-modal");
  const toInput = $("compose-to");
  if (!modal || !toInput) return;
  $("compose-to").value = ""; $("compose-cc").value = ""; $("compose-subject").value = ""; $("compose-body").value = "";
  const fb = $("compose-feedback"); if (fb) { fb.textContent = ""; fb.className = "email-reply-feedback"; }
  modal.classList.remove("hidden"); modal.setAttribute("aria-hidden", "false"); document.body.classList.add("modal-open");
  window.setTimeout(() => toInput.focus(), 40);
}

function closeComposeModal() {
  const modal = $("compose-modal");
  if (!modal) return;
  modal.classList.add("hidden"); modal.setAttribute("aria-hidden", "true"); document.body.classList.remove("modal-open");
}

async function sendNewEmail() {
  const toInput = $("compose-to");
  const feedback = $("compose-feedback");
  const sendButton = $("compose-send");
  if (!toInput || !feedback || !sendButton) return;
  try {
    sendButton.disabled = true; feedback.textContent = "Enviando..."; feedback.className = "email-reply-feedback";
    await postJSON(API_EMAIL_SEND, { to: toInput.value, cc: $("compose-cc").value, subject: $("compose-subject").value, body: $("compose-body").value });
    feedback.textContent = "Email enviado."; feedback.className = "email-reply-feedback ok";
    await loadAll(); window.setTimeout(closeComposeModal, 500);
  } catch (error) { feedback.textContent = error.message || "Falha."; feedback.className = "email-reply-feedback err"; }
  finally { sendButton.disabled = false; }
}

/* ========= BITRIX ACTIONS ========= */

function setBitrixFeedback(taskId, message, tone = "") {
  const el = document.querySelector(`.bitrix-feedback[data-task-id="${taskId}"]`);
  if (el) { el.textContent = message || ""; el.className = `bitrix-feedback${tone ? ` ${tone}` : ""}`; }
}

function setBitrixBusy(taskId, busy) {
  const item = document.querySelector(`.bitrix-item[data-task-id="${taskId}"]`);
  if (!item) return;
  item.classList.toggle("is-busy", busy);
  item.querySelectorAll("button, input, textarea").forEach(el => { el.disabled = busy; });
}

async function hydrateBitrixAccess(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const ids = tasks.map(t => String(t.id)).filter(id => id && !bitrixAccessCache[id] && !bitrixAccessPending.has(id));
  if (ids.length === 0) return;
  await Promise.all(ids.map(async id => {
    bitrixAccessPending.add(id);
    try {
      const data = await postJSON(API_BITRIX_ACCESS, { task_id: Number(id) });
      bitrixAccessCache[id] = data.result || {};
    } catch (error) { bitrixAccessCache[id] = { __error: error.message }; }
    finally { bitrixAccessPending.delete(id); }
  }));
  if (bitrixPayloadCache) renderBitrix(bitrixPayloadCache);
}

async function handleBitrixAction(action, taskId, button) {
  const item = button.closest(".bitrix-item");
  if (!item) return;
  try {
    setBitrixBusy(taskId, true); setBitrixFeedback(taskId, "Salvando...");
    await postJSON(API_BITRIX_ACTION, { task_id: Number(taskId), action });
    delete bitrixAccessCache[String(taskId)];
    await loadAll(); setBitrixFeedback(taskId, "Acao executada.", "ok");
  } catch (error) { setBitrixFeedback(taskId, error.message || "Falha.", "err"); }
  finally { setBitrixBusy(taskId, false); }
}

/* ========= LOAD & SYNC ========= */

async function loadAll() {
  try {
    const [datasets, , decisionResp] = await Promise.all([
      fetch(API_BOOTSTRAP, { cache: "no-store" }).then(r => r.json()).then(d => d.datasets || {}).catch(() => ({})),
      loadFocus(),
      fetch(API_DECISION, { cache: "no-store" }).then(r => r.json()).catch(() => ({ ok: false, briefing: null, priorities: [], queue: [], sidebar: {} })),
    ]);

    decisionData = decisionResp;
    const meta = datasets.meta || null;

    // Cockpit
    renderMeta(meta);
    renderBriefing(decisionResp.briefing);
    renderPriorities(decisionResp.priorities);
    renderFocus();
    renderQueue(decisionResp.queue);
    renderSideAgenda(decisionResp.sidebar, decisionResp.briefing);
    renderSideWaiting(decisionResp.sidebar);
    renderSideRisks(decisionResp.sidebar);
    renderSidePrep(decisionResp.sidebar);

    // Semana
    renderSemana(datasets);

    // Filtered sections
    renderFilteredSection("respostas", "respostas-badge", "respostas-list", i => i.actionType === "respond");
    renderFilteredSection("execucao", "execucao-badge", "execucao-list", i => i.actionType === "execute");
    renderFilteredSection("aguardando", "aguardando-badge", "aguardando-list", i => i.actionType === "follow_up");

    // Legacy source renders
    const bitrix = datasets.bitrix_tasks || null;
    const emails = datasets.emails_inbox || [];
    const sent = datasets.emails_sent || [];
    const calendar = datasets.calendar || [];
    const projects = datasets.projects || [];

    renderBitrix(bitrix);
    hydrateBitrixAccess((bitrix?.items || []).slice(0, 20));
    renderEmails(emails);
    renderEmailsSent(sent);
    renderCalendar(calendar);
    renderProjects(projects);
  } catch (error) {
    console.error("loadAll:", error);
    renderMeta(null);
  }
}

async function runSync() {
  const btn = $("sync-btn");
  const status = $("sync-status");
  btn.disabled = true; btn.classList.add("syncing");
  status.textContent = "Sincronizando..."; status.className = "sync-status";
  try {
    const r = await fetch(API_SYNC, { method: "POST" });
    const data = await r.json();
    if (data.ok) { status.textContent = "Sync ok"; status.className = "sync-status ok"; await loadAll(); }
    else { status.textContent = "Falha no sync"; status.className = "sync-status err"; }
  } catch (e) { status.textContent = "Erro de rede"; status.className = "sync-status err"; }
  finally { btn.disabled = false; btn.classList.remove("syncing"); }
}

/* ========= NAVIGATION ========= */

function initNav() {
  const navItems = document.querySelectorAll(".nav-item[data-section]");
  navItems.forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      navItems.forEach(x => x.classList.remove("active"));
      a.classList.add("active");
      const sectionId = a.dataset.section;
      document.querySelectorAll(".section").forEach(s => {
        s.classList.toggle("hidden", s.id !== sectionId);
      });
    });
  });
}

/* ========= INIT ========= */

function initCockpit() {
  // Focus actions
  const suggestBtn = $("focus-suggest-btn");
  if (suggestBtn) suggestBtn.addEventListener("click", handleFocusSuggest);
  const addBtn = $("focus-add-btn");
  if (addBtn) addBtn.addEventListener("click", handleFocusAdd);
  const addInput = $("focus-add-input");
  if (addInput) addInput.addEventListener("keydown", e => { if (e.key === "Enter") handleFocusAdd(); });

  // Focus toggle/remove delegation
  document.addEventListener("click", e => {
    const toggleEl = e.target.closest("[data-focus-toggle]");
    if (toggleEl) { handleFocusToggle(toggleEl.dataset.focusToggle); return; }
    const removeEl = e.target.closest("[data-focus-remove]");
    if (removeEl) { handleFocusRemove(removeEl.dataset.focusRemove); return; }
  });

  document.addEventListener("change", e => {
    if (e.target.matches("[data-focus-toggle]")) handleFocusToggle(e.target.dataset.focusToggle);
  });

  // Queue filters
  document.querySelectorAll(".queue-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".queue-filter").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      queueShowAll = false;
      if (decisionData) renderQueue(decisionData.queue);
    });
  });

  // Semana card click
  document.addEventListener("click", e => {
    const card = e.target.closest("[data-semana-day]");
    if (!card) return;
    const day = card.dataset.semanaDay;
    expandedSemanaDay = expandedSemanaDay === day ? null : day;
    loadAll();
  });
}

function initBitrixActions() {
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-bitrix-action]");
    if (!button) return;
    const item = button.closest(".bitrix-item");
    if (!item) return;
    handleBitrixAction(button.dataset.bitrixAction, item.dataset.taskId, button);
  });
}

function initEmailModal() {
  ensureEmailReplyUI();
  document.addEventListener("click", event => {
    const outlookTrigger = event.target.closest("[data-outlook-id]");
    if (outlookTrigger) { openOutlookEmailModal(outlookTrigger.dataset.outlookId); return; }
    const trigger = event.target.closest("[data-email-id][data-email-kind]");
    if (trigger) { openEmailModal(trigger.dataset.emailKind, trigger.dataset.emailId); return; }
    if (event.target.id === "email-modal-close" || event.target.id === "email-modal-overlay") { closeEmailModal(); return; }
    if (event.target.id === "compose-modal-close" || event.target.id === "compose-modal-overlay") closeComposeModal();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && document.activeElement?.id === "email-reply-input") { sendEmailReplyMode(false); return; }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && document.activeElement?.id === "compose-body") { sendNewEmail(); return; }
    if (event.key === "Escape") { closeEmailModal(); closeComposeModal(); }
  });
  const sendBtn = $("email-reply-send");
  if (sendBtn) sendBtn.addEventListener("click", () => sendEmailReplyMode(false));
  const sendAllBtn = $("email-reply-all-send");
  if (sendAllBtn) sendAllBtn.addEventListener("click", () => sendEmailReplyMode(true));
  const sugBtn = $("email-suggest-btn");
  if (sugBtn) sugBtn.addEventListener("click", handleSuggestReply);
  const newEmailBtn = $("new-email-btn");
  if (newEmailBtn) newEmailBtn.addEventListener("click", openComposeModal);
  const compSendBtn = $("compose-send");
  if (compSendBtn) compSendBtn.addEventListener("click", sendNewEmail);
}

document.addEventListener("DOMContentLoaded", () => {
  setGreeting();
  setToday();
  initNav();
  initCockpit();
  initBitrixActions();
  initEmailModal();
  $("sync-btn").addEventListener("click", runSync);
  loadAll();
});
