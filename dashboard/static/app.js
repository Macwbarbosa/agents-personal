/* ========= Sr. Bazinga Dashboard ========= */

const DATA_BASE = "/data";
const API_BOOTSTRAP = "/api/bootstrap";
const API_SYNC = "/api/sync";
const API_BITRIX_ACCESS = "/api/bitrix/access";
const API_BITRIX_UPDATE = "/api/bitrix/update";
const API_BITRIX_ACTION = "/api/bitrix/action";
const API_EMAIL_REPLY = "/api/email/reply";
const API_EMAIL_SEND = "/api/email/send";
const API_FOCUS = "/api/focus";
const API_FOCUS_SUGGEST = "/api/focus/suggest";
const API_FOCUS_TOGGLE = "/api/focus/toggle";
const API_FOCUS_REMOVE = "/api/focus/remove";
const API_FOCUS_MIGRATE = "/api/focus/migrate";
const API_OUTLOOK_MESSAGE = "/api/outlook/message";
const API_OUTLOOK_REPLY = "/api/outlook/reply";
const API_EMAIL_SUGGEST_REPLY = "/api/email/suggest-reply";

const $ = (id) => document.getElementById(id);
let bitrixPayloadCache = null;
const bitrixAccessCache = {};
const bitrixAccessPending = new Set();
const emailCache = {
  inbox: {},
  sent: {},
};
let activeEmailModal = null;
let currentFocusData = null;
let ovExpandedSemanaDay = null;
const miniDetailStore = {};

/* ---------- Utilitários ---------- */

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtDateOnly(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function setToday() {
  const now = new Date();
  const txt = now.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  $("today").textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
}

function setGreeting() {
  const h = new Date().getHours();
  let g = "Olá";
  if (h < 12) g = "Bom dia";
  else if (h < 18) g = "Boa tarde";
  else g = "Boa noite";
  $("greeting").textContent = `${g}, Mac`;
}

async function loadJSON(name) {
  try {
    const r = await fetch(`${DATA_BASE}/${name}.json`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function loadBootstrap() {
  const r = await fetch(API_BOOTSTRAP, { cache: "no-store" });
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }

  if (!r.ok || !data?.ok || !data?.datasets) {
    throw new Error("Falha ao carregar os dados do dashboard");
  }

  return data.datasets;
}

async function postJSON(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });

  let data = null;
  try {
    data = await r.json();
  } catch {
    data = { ok: false, error: `Resposta inválida em ${url}` };
  }

  if (!r.ok || !data.ok) {
    throw new Error(data?.error || `Falha na chamada ${url}`);
  }

  return data;
}

function empty(msg) {
  return `<div class="empty">${msg}</div>`;
}

function escapeHTML(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isPastDate(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  return !isNaN(d) && d.getTime() < Date.now();
}

function isoToLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join("-") + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputValueToIso(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return "";
  return d.toISOString();
}

function buildGmailMessageUrl(messageId) {
  if (!messageId) return "";
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;
}

function textToHTML(text) {
  return escapeHTML(text || "").replace(/\n/g, "<br>");
}

function ensureEmailReplyUI() {
  const modalCard = document.querySelector("#email-modal .modal-card");
  if (!modalCard) return false;

  let replyBox = $("email-reply-box");
  if (!replyBox) {
    modalCard.insertAdjacentHTML(
      "beforeend",
      `
      <div id="email-reply-box" class="email-reply-box hidden">
        <div class="email-reply-head">
          <div class="email-reply-title">Responder pelo dashboard</div>
          <div id="email-reply-target" class="email-reply-target"></div>
        </div>
        <textarea
          id="email-reply-input"
          class="email-reply-input"
          placeholder="Escreva sua resposta aqui…"
        ></textarea>
        <div class="email-reply-actions">
          <div id="email-reply-feedback" class="email-reply-feedback"></div>
          <div class="email-reply-buttons">
            <button id="email-reply-send" class="modal-send-btn secondary" type="button">Responder</button>
            <button id="email-reply-all-send" class="modal-send-btn" type="button">Responder a todos</button>
          </div>
        </div>
      </div>
    `
    );
    replyBox = $("email-reply-box");
  }

  return Boolean(replyBox && $("email-reply-input") && $("email-reply-send") && $("email-reply-all-send"));
}

function cacheEmails(kind, emails) {
  emailCache[kind] = {};
  (emails || []).forEach((email) => {
    if (email?.id) {
      emailCache[kind][String(email.id)] = email;
    }
  });
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
  if (kind === "sent") {
    metaParts.push(`Para: ${email.to || "—"}`);
  } else {
    metaParts.push(`De: ${email.from || "—"}`);
  }
  if (email.date) metaParts.push(email.date);
  meta.textContent = metaParts.join(" · ");

  const body = email.body_text || email.snippet || "Sem conteúdo disponível.";
  bodyEl.innerHTML = textToHTML(body);

  const replyBox = $("email-reply-box");
  const replyInput = $("email-reply-input");
  const replyFeedback = $("email-reply-feedback");
  const replyTarget = $("email-reply-target");
  const replyButton = $("email-reply-send");
  const replyAllButton = $("email-reply-all-send");
  const canReply =
    kind === "inbox" &&
    replyBox &&
    replyInput &&
    replyFeedback &&
    replyTarget &&
    replyButton &&
    replyAllButton;

  if (replyBox && replyInput && replyFeedback && replyTarget && replyButton && replyAllButton) {
    replyBox.classList.toggle("hidden", !canReply);
    replyInput.value = "";
    replyFeedback.textContent = "";
    replyFeedback.className = "email-reply-feedback";
    replyButton.disabled = false;
    replyAllButton.disabled = false;

    if (canReply) {
      replyTarget.textContent = email.reply_to || email.from || "destinatário desconhecido";
      window.setTimeout(() => replyInput.focus(), 40);
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
  const replyInput = $("email-reply-input");
  const replyFeedback = $("email-reply-feedback");
  const replyTarget = $("email-reply-target");
  const replyButton = $("email-reply-send");
  const replyAllButton = $("email-reply-all-send");
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
    const metaParts = [`De: ${email.from || "—"}`];
    if (email.date) metaParts.push(fmtDate(email.date));
    if (email.to) metaParts.push(`Para: ${email.to}`);
    meta.textContent = metaParts.join(" · ");

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
      bodyEl.innerHTML = textToHTML(email.body_text || "Sem conteúdo.");
    }

    // Show reply box for Outlook
    if (replyBox && replyInput && replyFeedback && replyTarget && replyButton && replyAllButton) {
      replyBox.classList.remove("hidden");
      replyInput.value = "";
      replyFeedback.textContent = "";
      replyFeedback.className = "email-reply-feedback";
      replyButton.disabled = false;
      replyAllButton.disabled = false;
      replyTarget.textContent = email.reply_to || email.from_email || email.from || "destinatário";
      window.setTimeout(() => replyInput.focus(), 40);
    }
  } catch (err) {
    subject.textContent = "Erro ao carregar";
    bodyEl.innerHTML = `<div class="empty">${escapeHTML(err.message || "Falha ao buscar email.")}</div>`;
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

async function sendEmailReply() {
  return sendEmailReplyMode(false);
}

async function sendEmailReplyAll() {
  return sendEmailReplyMode(true);
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

  if (!replyText) {
    replyFeedback.textContent = "Escreva a resposta antes de enviar.";
    replyFeedback.className = "email-reply-feedback err";
    replyInput.focus();
    return;
  }

  try {
    replyButton.disabled = true;
    replyAllButton.disabled = true;
    replyFeedback.textContent = "Enviando resposta…";
    replyFeedback.className = "email-reply-feedback";

    if (kind === "outlook") {
      await postJSON(API_OUTLOOK_REPLY, {
        id: activeEmailModal.email.id,
        reply_text: replyText,
      });
    } else {
      await postJSON(API_EMAIL_REPLY, {
        original_email: activeEmailModal.email,
        reply_text: replyText,
        reply_all: replyAll,
      });
    }

    replyInput.value = "";
    replyFeedback.textContent = replyAll ? "Resposta para todos enviada." : "Resposta enviada.";
    replyFeedback.className = "email-reply-feedback ok";
    await loadAll();
  } catch (error) {
    console.error(error);
    replyFeedback.textContent = error.message || "Falha ao enviar resposta.";
    replyFeedback.className = "email-reply-feedback err";
  } finally {
    replyButton.disabled = false;
    replyAllButton.disabled = false;
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
    suggestBtn.disabled = true;
    suggestBtn.textContent = "Gerando...";
    replyFeedback.textContent = "Solicitando sugestão ao Claude...";
    replyFeedback.className = "email-reply-feedback";

    const bodyText = email.body_text || email.snippet || email.preview || "";
    const sender = email.from_name || email.from || email.from_email || "";

    const resp = await postJSON(API_EMAIL_SUGGEST_REPLY, {
      subject: email.subject || "",
      sender: sender,
      body: bodyText.slice(0, 4000),
    });

    if (resp.suggestion) {
      replyInput.value = resp.suggestion;
      replyFeedback.textContent = "Sugestão gerada. Revise e edite antes de enviar.";
      replyFeedback.className = "email-reply-feedback ok";
      replyInput.focus();
    }
  } catch (error) {
    console.error(error);
    replyFeedback.textContent = error.message || "Falha ao gerar sugestão.";
    replyFeedback.className = "email-reply-feedback err";
  } finally {
    suggestBtn.disabled = false;
    suggestBtn.textContent = "Sugerir resposta";
  }
}

function openComposeModal() {
  const modal = $("compose-modal");
  const toInput = $("compose-to");
  const ccInput = $("compose-cc");
  const subjectInput = $("compose-subject");
  const bodyInput = $("compose-body");
  const feedback = $("compose-feedback");
  const sendButton = $("compose-send");
  if (!modal || !toInput || !ccInput || !subjectInput || !bodyInput || !feedback || !sendButton) return;

  toInput.value = "";
  ccInput.value = "";
  subjectInput.value = "";
  bodyInput.value = "";
  feedback.textContent = "";
  feedback.className = "email-reply-feedback";
  sendButton.disabled = false;

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.setTimeout(() => toInput.focus(), 40);
}

function closeComposeModal() {
  const modal = $("compose-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

async function sendNewEmail() {
  const toInput = $("compose-to");
  const ccInput = $("compose-cc");
  const subjectInput = $("compose-subject");
  const bodyInput = $("compose-body");
  const feedback = $("compose-feedback");
  const sendButton = $("compose-send");
  if (!toInput || !ccInput || !subjectInput || !bodyInput || !feedback || !sendButton) return;

  try {
    sendButton.disabled = true;
    feedback.textContent = "Enviando email…";
    feedback.className = "email-reply-feedback";

    await postJSON(API_EMAIL_SEND, {
      to: toInput.value,
      cc: ccInput.value,
      subject: subjectInput.value,
      body: bodyInput.value,
    });

    feedback.textContent = "Email enviado.";
    feedback.className = "email-reply-feedback ok";
    await loadAll();
    window.setTimeout(closeComposeModal, 500);
  } catch (error) {
    console.error(error);
    feedback.textContent = error.message || "Falha ao enviar email.";
    feedback.className = "email-reply-feedback err";
  } finally {
    sendButton.disabled = false;
  }
}

function bitrixAccessFor(taskId) {
  return bitrixAccessCache[String(taskId)] || null;
}

function bitrixActionAllowed(access, key) {
  if (!access || access.__error) return false;
  return Boolean(access[key]);
}

function setBitrixFeedback(taskId, message, tone = "") {
  const el = document.querySelector(`.bitrix-feedback[data-task-id="${taskId}"]`);
  if (!el) return;
  el.textContent = message || "";
  el.className = `bitrix-feedback${tone ? ` ${tone}` : ""}`;
}

function setBitrixBusy(taskId, busy) {
  const item = document.querySelector(`.bitrix-item[data-task-id="${taskId}"]`);
  if (!item) return;
  item.classList.toggle("is-busy", busy);
  item.querySelectorAll("button, input, textarea").forEach((el) => {
    el.disabled = busy;
  });
}

async function hydrateBitrixAccess(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;

  const ids = tasks
    .map((task) => String(task.id))
    .filter((id) => id && !bitrixAccessCache[id] && !bitrixAccessPending.has(id));

  if (ids.length === 0) return;

  await Promise.all(
    ids.map(async (id) => {
      bitrixAccessPending.add(id);
      try {
        const data = await postJSON(API_BITRIX_ACCESS, { task_id: Number(id) });
        bitrixAccessCache[id] = data.result || {};
      } catch (error) {
        bitrixAccessCache[id] = { __error: error.message || "Falha ao carregar permissões" };
      } finally {
        bitrixAccessPending.delete(id);
      }
    })
  );

  if (bitrixPayloadCache) {
    renderBitrix(bitrixPayloadCache);
  }
}

/* ---------- Renderizações ---------- */

function renderMeta(meta) {
  if (!meta) {
    $("sync-status").textContent = "Sem dados — rode sync";
    $("sync-status").className = "sync-status err";
    return;
  }
  const m = meta.metrics || {};
  $("metric-pending").textContent = m.pending_tasks ?? "–";
  const totalUnread = (m.unread_emails || 0) + (m.outlook_unread || 0);
  $("metric-emails").textContent = totalUnread || "–";
  const totalEvents = (m.events_today || 0) + (m.m365_events_today || 0);
  $("metric-events").textContent = totalEvents || "–";
  $("metric-projects").textContent = m.active_projects ?? "–";

  if (meta.last_sync) {
    $("last-sync").textContent = `Sync: ${fmtDate(meta.last_sync)}`;
    $("sync-status").textContent = "Atualizado";
    $("sync-status").className = "sync-status ok";
  }
}

function renderPending(tasks) {
  const list = $("pending-list");
  if (!tasks || tasks.length === 0) {
    list.innerHTML = empty("Nenhuma pendência registrada.");
    $("pending-badge").textContent = "0";
    return;
  }
  const open = tasks.filter((t) => !t.done);
  $("pending-badge").textContent = open.length;

  list.innerHTML = tasks
    .slice(0, 20)
    .map(
      (t) => `
      <div class="list-item${t.done ? " done" : ""}">
        <div class="list-dot${t.done ? " green" : ""}"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(t.text)}</div>
          <div class="list-sub">
            <span class="list-tag">${escapeHTML(t.section || "Geral")}</span>
          </div>
        </div>
      </div>
    `
    )
    .join("");
}

function renderEmails(emails) {
  const list = $("emails-list");
  if (!emails || emails.length === 0) {
    list.innerHTML = empty("Inbox vazia ou sem sincronização.");
    $("emails-badge").textContent = "0";
    return;
  }
  const unread = emails.filter((e) => e.unread).length;
  $("emails-badge").textContent = unread;
  cacheEmails("inbox", emails);

  list.innerHTML = emails
    .map((e) => {
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
    })
    .join("");
}

function renderEmailsSent(emails) {
  const list = $("emails-sent-list");
  if (!emails || emails.length === 0) {
    list.innerHTML = empty("Nenhum email enviado recentemente.");
    return;
  }
  cacheEmails("sent", emails);
  list.innerHTML = emails
    .map((e) => {
      const toName = (e.to || "").replace(/<.*>/, "").trim() || e.to;
      return `
      <button class="list-item list-item-button" type="button" data-email-kind="sent" data-email-id="${escapeHTML(e.id || "")}">
        <div class="list-dot blue"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(e.subject || "(sem assunto)")}</div>
          <div class="list-sub">→ ${escapeHTML(toName)} · ${escapeHTML(e.snippet || "")}</div>
        </div>
        <div class="list-meta">${escapeHTML((e.date || "").split(" ").slice(0, 4).join(" "))}</div>
      </button>
    `;
    })
    .join("");
}

function renderCalendar(events) {
  const list = $("calendar-list");
  if (!events || events.length === 0) {
    list.innerHTML = empty("Nenhum compromisso nos próximos dias.");
    $("calendar-badge").textContent = "0";
    return;
  }
  $("calendar-badge").textContent = events.length;

  const today = new Date().toISOString().slice(0, 10);
  list.innerHTML = events
    .map((e) => {
      const isToday = (e.start || "").startsWith(today);
      return `
      <div class="list-item">
        <div class="list-dot ${isToday ? "green" : "blue"}"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(e.title)}</div>
          <div class="list-sub">
            ${escapeHTML(e.location || "Sem local")}
          </div>
        </div>
        <div class="list-meta">${escapeHTML(fmtDate(e.start))}</div>
      </div>
    `;
    })
    .join("");
}

function renderProjects(projects) {
  const list = $("projects-list");
  if (!projects || projects.length === 0) {
    list.innerHTML = empty("Nenhum projeto na memória.");
    $("projects-badge").textContent = "0";
    return;
  }
  $("projects-badge").textContent = projects.length;

  const colors = ["", "orange", "green", "blue"];
  list.innerHTML = projects
    .map((p, i) => {
      const initials = (p.title || "P")
        .split(" ")
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase();
      return `
      <div class="card">
        <div class="card-header">
          <div class="card-avatar ${colors[i % colors.length]}">${escapeHTML(initials)}</div>
          <div>
            <div class="card-title">${escapeHTML(p.title)}</div>
            <div class="card-role">${escapeHTML(p.slug)}</div>
          </div>
        </div>
        <div class="card-body">${escapeHTML(p.description || "Sem descrição")}</div>
        <div class="card-footer">
          <span><span class="status-dot"></span>ativo</span>
          <span>${fmtDateOnly(p.modified)}</span>
        </div>
      </div>
    `;
    })
    .join("");
}

function renderBitrix(payload) {
  bitrixPayloadCache = payload;
  const list = $("bitrix-list");
  const badge = $("bitrix-badge");

  if (!payload || !payload.configured) {
    badge.textContent = "0";
    list.innerHTML = empty("Webhook do Bitrix ainda nao configurado.");
    return;
  }

  if (payload.error) {
    badge.textContent = "!";
    list.innerHTML = empty(`Falha ao carregar o Bitrix: ${escapeHTML(payload.error)}`);
    return;
  }

  const tasks = Array.isArray(payload.items) ? payload.items : [];
  const openCount =
    payload.open_count ?? tasks.filter((task) => !task.done).length;

  badge.textContent = String(openCount);

  if (tasks.length === 0) {
    list.innerHTML = empty("Nenhuma tarefa encontrada no Bitrix.");
    return;
  }

  list.innerHTML = tasks
    .slice(0, 20)
    .map((task) => {
      const access = bitrixAccessFor(task.id);
      const overdue = !task.done && isPastDate(task.deadline);
      const dotClass = task.done ? "green" : overdue ? "red" : "blue";
      const title = escapeHTML(task.title || `Tarefa #${task.id || "?"}`);
      const link = task.url
        ? `<a class="list-link" href="${escapeHTML(task.url)}" target="_blank" rel="noreferrer">${title}</a>`
        : title;

      const metaPieces = [];
      if (task.status_label) {
        metaPieces.push(`<span class="list-tag">${escapeHTML(task.status_label)}</span>`);
      }
      if (task.group_name) {
        metaPieces.push(`<span class="list-tag">${escapeHTML(task.group_name)}</span>`);
      }
      if (overdue) {
        metaPieces.push(`<span class="list-tag red">Atrasada</span>`);
      }

      const ownerLine =
        task.creator_name || task.responsible_name
          ? `${escapeHTML(task.creator_name || "Sem criador")} → ${escapeHTML(
              task.responsible_name || "Sem responsavel"
            )}`
          : "Sem responsavel";

      const dateLabel = task.done
        ? task.closed_date
          ? `Concluida em ${fmtDate(task.closed_date)}`
          : "Concluida"
        : task.deadline
          ? `Prazo ${fmtDate(task.deadline)}`
          : task.changed_date
            ? `Atualizada ${fmtDate(task.changed_date)}`
            : task.created_date
            ? `Criada ${fmtDate(task.created_date)}`
              : "";

      const canStart = !task.done && (
        bitrixActionAllowed(access, "start") ||
        bitrixActionAllowed(access, "changeStatus")
      );
      const canComplete = !task.done && bitrixActionAllowed(access, "complete");
      const canDefer = !task.done && bitrixActionAllowed(access, "defer");
      const canRenew = task.done && bitrixActionAllowed(access, "renew");
      const accessHint = access?.__error
        ? "Permissões indisponíveis"
        : access
          ? "Permissões carregadas"
          : "Carregando permissões…";

      return `
      <div class="list-item bitrix-item${task.done ? " done" : ""}" data-task-id="${escapeHTML(task.id)}">
        <div class="list-dot ${dotClass}"></div>
        <div class="list-body">
          <div class="list-title">${link}</div>
          <div class="list-sub">${metaPieces.join("")}</div>
          <div class="list-sub">${ownerLine}</div>
          <div class="bitrix-controls">
            <div class="bitrix-form-row bitrix-actions-row">
              <button class="bitrix-btn" data-bitrix-action="start" ${canStart ? "" : "disabled"}>
                Iniciar
              </button>
              <button class="bitrix-btn warning" data-bitrix-action="defer" ${canDefer ? "" : "disabled"}>
                Adiar
              </button>
              <button class="bitrix-btn success" data-bitrix-action="complete" ${canComplete ? "" : "disabled"}>
                Concluir
              </button>
              <button class="bitrix-btn" data-bitrix-action="renew" ${canRenew ? "" : "disabled"}>
                Reabrir
              </button>
            </div>
            <div class="bitrix-access-hint">${escapeHTML(accessHint)}</div>
            <div class="bitrix-feedback" data-task-id="${escapeHTML(task.id)}"></div>
          </div>
        </div>
        <div class="list-meta">${escapeHTML(dateLabel)}</div>
      </div>
    `;
    })
    .join("");
}

function renderAgents(agents) {
  const list = $("agents-list");
  if (!agents || agents.length === 0) {
    list.innerHTML = empty("Nenhum agente registrado.");
    $("agents-badge").textContent = "0";
    return;
  }
  $("agents-badge").textContent = agents.length;

  const colors = ["", "orange", "green", "blue"];
  list.innerHTML = agents
    .map((a, i) => {
      const initials = (a.name || "A")
        .split(" ")
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase();
      return `
      <div class="card">
        <div class="card-header">
          <div class="card-avatar ${colors[i % colors.length]}">${escapeHTML(initials)}</div>
          <div>
            <div class="card-title">${escapeHTML(a.name)}</div>
            <div class="card-role">${escapeHTML(a.slug)}</div>
          </div>
        </div>
        <div class="card-body">
          Última sessão: ${escapeHTML(a.last_session || "—")}
        </div>
        <div class="card-footer">
          <span><span class="status-dot"></span>${escapeHTML(a.status || "—")}</span>
        </div>
      </div>
    `;
    })
    .join("");
}

function renderTeam(people) {
  const list = $("team-list");
  if (!people || people.length === 0) {
    list.innerHTML = empty("Equipe não registrada.");
    $("team-badge").textContent = "0";
    return;
  }
  $("team-badge").textContent = people.length;

  const colors = ["", "orange", "green", "blue"];
  list.innerHTML = people
    .map((p, i) => {
      const initials = (p.name || "?")
        .split(" ")
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase();
      return `
      <div class="card">
        <div class="card-header">
          <div class="card-avatar ${colors[i % colors.length]}">${escapeHTML(initials)}</div>
          <div>
            <div class="card-title">${escapeHTML(p.name)}</div>
            <div class="card-role">${escapeHTML(p.role || "")}</div>
          </div>
        </div>
        <div class="card-body">
          ${escapeHTML(p.email || "")}
          ${p.notes ? `<br>${escapeHTML(p.notes)}` : ""}
        </div>
      </div>
    `;
    })
    .join("");
}

/* ---------- Overview v2: helpers ---------- */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function getOvView() {
  return localStorage.getItem("ov-view") || "hoje";
}

function setOvView(view) {
  localStorage.setItem("ov-view", view);
}

/* ---------- Overview v2: Focus ---------- */

async function loadFocus() {
  try {
    const resp = await fetch(`${API_FOCUS}?date=${todayISO()}`, { cache: "no-store" });
    const data = await resp.json();
    if (data.ok) currentFocusData = data.focus;
  } catch (e) {
    console.error("loadFocus:", e);
  }
}

function renderFocus() {
  const list = $("focus-list");
  if (!list) return;
  if (!currentFocusData || !currentFocusData.items || currentFocusData.items.length === 0) {
    list.innerHTML = '<div class="ov-mini-empty">Nenhum foco definido. Clique "Sugerir de novo" para começar.</div>';
    return;
  }
  list.innerHTML = currentFocusData.items.map(item => {
    const age = item.age_tag ? `<span class="ov-focus-age">${escapeHTML(item.age_tag)}</span>` : "";
    const source = item.source && item.source !== "manual"
      ? `<span class="ov-focus-meta">${escapeHTML(item.source.split(":")[0])}</span>`
      : "";
    return `
      <div class="ov-focus-item${item.done ? " done" : ""}" data-focus-id="${escapeHTML(item.id)}">
        <input type="checkbox" class="ov-focus-check" ${item.done ? "checked" : ""} data-focus-toggle="${escapeHTML(item.id)}">
        <span class="ov-focus-text">${escapeHTML(item.text)}${age}</span>
        ${source}
        <button class="ov-focus-remove" data-focus-remove="${escapeHTML(item.id)}" title="Remover">×</button>
      </div>
    `;
  }).join("");
}

async function handleFocusSuggest() {
  const btn = $("focus-suggest-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando..."; }
  try {
    // Primeiro migra pendentes de dias anteriores
    await postJSON(API_FOCUS_MIGRATE, { date: todayISO() });
    // Depois gera novas sugestões
    const resp = await postJSON(API_FOCUS_SUGGEST, { date: todayISO() });
    if (resp.focus) currentFocusData = resp.focus;
    renderFocus();
  } catch (e) {
    console.error("suggest:", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Sugerir de novo"; }
  }
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

/* ---------- Overview v2: Agenda Hoje ---------- */

function renderAgendaHoje(m365Events, googleEvents) {
  const list = $("agenda-hoje-list");
  if (!list) return;
  const today = todayISO();

  const allEvents = [
    ...(m365Events || []).filter(e => (e.start || "").startsWith(today)),
    ...(googleEvents || []).filter(e => (e.start || "").startsWith(today)),
  ].sort((a, b) => (a.start || "").localeCompare(b.start || ""));

  if (allEvents.length === 0) {
    list.innerHTML = '<div class="ov-mini-empty">Nenhum compromisso hoje.</div>';
    return;
  }

  list.innerHTML = allEvents.map(ev => {
    const time = fmtTime(ev.start);
    const online = ev.online || ev.join_url;
    const joinLink = ev.join_url
      ? `<a class="ov-agenda-join" href="${escapeHTML(ev.join_url)}" target="_blank" rel="noreferrer">Entrar</a>`
      : "";
    const onlineBadge = online ? '<span class="ov-agenda-badge-online">Online</span>' : "";
    const loc = ev.location ? escapeHTML(ev.location) : "";
    const sub = [loc, ev.organizer_name ? `Org: ${escapeHTML(ev.organizer_name)}` : ""].filter(Boolean).join(" · ");
    return `
      <div class="ov-agenda-item">
        <div class="ov-agenda-time">${escapeHTML(time)}</div>
        <div class="ov-agenda-body">
          <div class="ov-agenda-title">${escapeHTML(ev.title)}</div>
          ${sub ? `<div class="ov-agenda-sub">${sub}</div>` : ""}
        </div>
        ${onlineBadge}
        ${joinLink}
      </div>
    `;
  }).join("");
}

/* ---------- Overview v2: Tarefas do Dia ---------- */

function renderTarefasDia(bitrixTasks) {
  const list = $("tarefas-dia-list");
  const expandBtn = $("tarefas-expand-btn");
  if (!list) return;

  const items = (bitrixTasks?.items || []).filter(t => !t.done);
  const today = todayISO();
  const overdue = items.filter(t => t.deadline && t.deadline.slice(0, 10) < today);
  const dueToday = items.filter(t => t.deadline && t.deadline.slice(0, 10) === today);
  const rest = items.filter(t => !t.deadline || (t.deadline.slice(0, 10) > today));

  const MAX_OVERDUE_VISIBLE = 3;
  let showAllOverdue = false;

  function render() {
    const sections = [];

    if (overdue.length > 0) {
      const visible = showAllOverdue ? overdue : overdue.slice(0, MAX_OVERDUE_VISIBLE);
      sections.push(`<div class="list-sub" style="margin-bottom:6px;font-weight:600;color:var(--red)">Atrasadas (${overdue.length})</div>`);
      sections.push(...visible.map(t => renderTaskItem(t, "red")));
    }

    if (dueToday.length > 0) {
      sections.push(`<div class="list-sub" style="margin:10px 0 6px;font-weight:600;color:var(--orange)">Prazo hoje (${dueToday.length})</div>`);
      sections.push(...dueToday.map(t => renderTaskItem(t, "orange")));
    }

    if (rest.length > 0 && (overdue.length + dueToday.length) === 0) {
      sections.push(`<div class="list-sub" style="margin-bottom:6px;font-weight:600;color:var(--blue)">Próximas</div>`);
      sections.push(...rest.slice(0, 5).map(t => renderTaskItem(t, "blue")));
    }

    if (sections.length === 0) {
      list.innerHTML = '<div class="ov-mini-empty">Nenhuma tarefa pendente no Bitrix.</div>';
    } else {
      list.innerHTML = sections.join("");
    }

    if (expandBtn) {
      if (overdue.length > MAX_OVERDUE_VISIBLE && !showAllOverdue) {
        expandBtn.classList.remove("hidden");
        expandBtn.textContent = `Ver todas atrasadas (${overdue.length})`;
      } else {
        expandBtn.classList.add("hidden");
      }
    }
  }

  render();

  if (expandBtn) {
    expandBtn.onclick = () => {
      showAllOverdue = true;
      render();
    };
  }
}

function renderTaskItem(t, dotColor) {
  const title = escapeHTML(t.title || `#${t.id}`);
  const link = t.url ? `<a class="list-link" href="${escapeHTML(t.url)}" target="_blank" rel="noreferrer">${title}</a>` : title;
  const deadline = t.deadline ? fmtDate(t.deadline) : "";
  return `
    <div class="list-item" style="padding:10px 14px">
      <div class="list-dot ${dotColor}"></div>
      <div class="list-body">
        <div class="list-title">${link}</div>
        <div class="list-sub">${escapeHTML(t.group_name || "")} ${t.status_label ? `<span class="list-tag">${escapeHTML(t.status_label)}</span>` : ""}</div>
      </div>
      ${deadline ? `<div class="list-meta">${escapeHTML(deadline)}</div>` : ""}
    </div>
  `;
}

/* ---------- Overview v2: Caixa de Ação ---------- */

function renderCaixaAcao(outlookInbox, gmailInbox) {
  const list = $("caixa-acao-list");
  if (!list) return;

  const actionable = [];

  (outlookInbox || []).forEach(m => {
    if (m.unread || m.flagged) {
      actionable.push({
        id: m.id || "",
        subject: m.subject || "(sem assunto)",
        from: m.from_name || m.from_email || "remetente",
        date: m.received || "",
        source: "outlook",
        flagged: m.flagged,
      });
    }
  });

  (gmailInbox || []).forEach(m => {
    if (m.unread) {
      actionable.push({
        id: m.id || "",
        subject: m.subject || "(sem assunto)",
        from: (m.from || "").replace(/<.*>/, "").trim() || "remetente",
        date: m.date || "",
        source: "gmail",
        flagged: false,
      });
    }
  });

  if (actionable.length === 0) {
    list.innerHTML = '<div class="ov-mini-empty">Nenhum email pendente de ação.</div>';
    return;
  }

  const countEl = $("caixa-acao-count");
  if (countEl) countEl.textContent = `${actionable.length} pendente${actionable.length > 1 ? "s" : ""}`;

  const MAX_CAIXA = 5;
  let showAll = false;

  function renderCaixa() {
    const visible = showAll ? actionable : actionable.slice(0, MAX_CAIXA);
    const items = visible.map(m => {
    const dot = m.flagged ? "red" : m.source === "outlook" ? "blue" : "orange";
    const badge = m.source === "outlook" ? "Outlook" : "Gmail";
    const isOutlook = m.source === "outlook";
    const tag = isOutlook
      ? `button class="list-item list-item-button" type="button" data-outlook-id="${escapeHTML(m.id || "")}"`
      : `button class="list-item list-item-button" type="button" data-email-kind="inbox" data-email-id="${escapeHTML(m.id || "")}"`;
    return `
      <${tag} style="padding:10px 14px">
        <div class="list-dot ${dot}"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(m.subject)}</div>
          <div class="list-sub">${escapeHTML(m.from)} <span class="list-tag">${escapeHTML(badge)}</span>${m.flagged ? '<span class="list-tag red">Flag</span>' : ""}</div>
        </div>
        <div class="list-meta">${escapeHTML(fmtDate(m.date))}</div>
      </button>
    `;
    }).join("");

    const more = !showAll && actionable.length > MAX_CAIXA
      ? `<button class="ov-action-btn" style="margin-top:8px;width:100%;text-align:center;" id="caixa-ver-mais">Ver todos (${actionable.length})</button>`
      : "";
    list.innerHTML = items + more;

    const verMaisBtn = $("caixa-ver-mais");
    if (verMaisBtn) {
      verMaisBtn.onclick = () => { showAll = true; renderCaixa(); };
    }
  }

  renderCaixa();
}

/* ---------- Overview v2: 4 blocos extras (clicáveis) ---------- */

function storeMiniDetail(id, data) {
  miniDetailStore[id] = data;
}

function renderMiniItem(id, dotColor, text, meta, detailHTML) {
  storeMiniDetail(id, detailHTML);
  return `
    <div class="ov-mini-item ov-mini-clickable" data-mini-id="${escapeHTML(id)}">
      <div class="ov-mini-dot ${dotColor}"></div>
      <span class="ov-mini-text">${text}</span>
      <span class="ov-mini-meta">${escapeHTML(meta)}</span>
    </div>
    <div class="ov-mini-detail hidden" id="mini-detail-${escapeHTML(id)}"></div>
  `;
}

function toggleMiniDetail(id) {
  const el = document.getElementById(`mini-detail-${id}`);
  if (!el) return;
  const isOpen = !el.classList.contains("hidden");
  // Close all others in same list
  el.parentElement.querySelectorAll(".ov-mini-detail").forEach(d => d.classList.add("hidden"));
  el.parentElement.querySelectorAll(".ov-mini-clickable").forEach(d => d.classList.remove("ov-mini-active"));
  if (!isOpen) {
    el.innerHTML = miniDetailStore[id] || "";
    el.classList.remove("hidden");
    const trigger = el.previousElementSibling;
    if (trigger) trigger.classList.add("ov-mini-active");
  }
}

function renderAguardando(outlookSent, gmailSent) {
  const list = $("aguardando-list");
  if (!list) return;
  const items = [
    ...(gmailSent || []).slice(0, 5).map(m => ({
      to: (m.to || "").replace(/<.*>/, "").trim(),
      subject: m.subject || "(sem assunto)",
      date: m.date || "",
      snippet: m.snippet || m.body_text || "",
      source: "gmail",
      id: m.id,
    })),
  ];
  if (items.length === 0) {
    list.innerHTML = '<div class="ov-mini-empty">Nenhum pendente.</div>';
    return;
  }
  list.innerHTML = items.map((m, i) => {
    const detail = `
      <div class="ov-detail-row"><strong>Para:</strong> ${escapeHTML(m.to)}</div>
      <div class="ov-detail-row"><strong>Assunto:</strong> ${escapeHTML(m.subject)}</div>
      <div class="ov-detail-row"><strong>Enviado:</strong> ${escapeHTML(fmtDate(m.date))}</div>
      ${m.snippet ? `<div class="ov-detail-snippet">${escapeHTML(m.snippet).slice(0, 150)}...</div>` : ""}
    `;
    return renderMiniItem(`ag-${i}`, "orange", escapeHTML(m.to) + ": " + escapeHTML(m.subject), fmtDate(m.date), detail);
  }).join("");
}

function renderProjetosParados(projects) {
  const list = $("projetos-parados-list");
  if (!list) return;
  const now = Date.now();
  const stale = (projects || []).filter(p => {
    if (!p.modified) return true;
    return (now - new Date(p.modified).getTime()) > 7 * 24 * 3600 * 1000;
  });
  if (stale.length === 0) {
    list.innerHTML = '<div class="ov-mini-empty">Todos com atividade recente.</div>';
    return;
  }
  list.innerHTML = stale.map((p, i) => {
    const days = Math.floor((now - new Date(p.modified).getTime()) / (24 * 3600 * 1000));
    const detail = `
      <div class="ov-detail-row"><strong>${escapeHTML(p.title)}</strong></div>
      <div class="ov-detail-row">Sem atividade há <strong>${days} dias</strong></div>
      ${p.description ? `<div class="ov-detail-snippet">${escapeHTML(p.description).slice(0, 200)}</div>` : ""}
      <div class="ov-detail-row" style="margin-top:4px"><a href="#projects" class="ov-detail-link">Ir para Projetos</a></div>
    `;
    return renderMiniItem(`proj-${i}`, "red", escapeHTML(p.title), fmtDateOnly(p.modified), detail);
  }).join("");
}

function renderDecisoesDia(m365Events, googleEvents) {
  const list = $("decisoes-list");
  if (!list) return;
  const today = todayISO();
  const meetings = [
    ...(m365Events || []).filter(e => (e.start || "").startsWith(today)),
    ...(googleEvents || []).filter(e => (e.start || "").startsWith(today)),
  ].filter(ev => {
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    return !isNaN(s) && !isNaN(e) && (e - s) >= 30 * 60 * 1000;
  });

  if (meetings.length === 0) {
    list.innerHTML = '<div class="ov-mini-empty">Nenhuma reunião decisória hoje.</div>';
    return;
  }
  list.innerHTML = meetings.map((ev, i) => {
    const attendees = (ev.attendees || []).map(a => a.name || a.email).filter(Boolean).join(", ");
    const detail = `
      <div class="ov-detail-row"><strong>${escapeHTML(ev.title)}</strong></div>
      <div class="ov-detail-row">${escapeHTML(fmtTime(ev.start))} — ${escapeHTML(fmtTime(ev.end))}</div>
      ${ev.location ? `<div class="ov-detail-row">Local: ${escapeHTML(ev.location)}</div>` : ""}
      ${attendees ? `<div class="ov-detail-row">Participantes: ${escapeHTML(attendees)}</div>` : ""}
      ${ev.join_url ? `<div class="ov-detail-row"><a href="${escapeHTML(ev.join_url)}" target="_blank" rel="noreferrer" class="ov-detail-link">Entrar na reunião</a></div>` : ""}
      ${ev.preview ? `<div class="ov-detail-snippet">${escapeHTML(ev.preview).slice(0, 150)}</div>` : ""}
    `;
    return renderMiniItem(`dec-${i}`, "purple", escapeHTML(fmtTime(ev.start)) + " — " + escapeHTML(ev.title), "", detail);
  }).join("");
}

function renderRevisoes(m365Events, googleEvents) {
  const list = $("revisoes-list");
  if (!list) return;
  const today = todayISO();
  const allEvents = [...(m365Events || []), ...(googleEvents || [])];
  const pattern = /review|revis[aã]o|planning|feedback|retro|fup|recorrente/i;
  const reviews = allEvents.filter(e => pattern.test(e.title || "") && (e.start || "").slice(0, 10) >= today).slice(0, 5);

  if (reviews.length === 0) {
    list.innerHTML = '<div class="ov-mini-empty">Nenhuma revisão agendada.</div>';
    return;
  }
  list.innerHTML = reviews.map((ev, i) => {
    const attendees = (ev.attendees || []).map(a => a.name || a.email).filter(Boolean).join(", ");
    const detail = `
      <div class="ov-detail-row"><strong>${escapeHTML(ev.title)}</strong></div>
      <div class="ov-detail-row">${escapeHTML(fmtDate(ev.start))} — ${escapeHTML(fmtTime(ev.end))}</div>
      ${ev.location ? `<div class="ov-detail-row">Local: ${escapeHTML(ev.location)}</div>` : ""}
      ${ev.organizer_name ? `<div class="ov-detail-row">Organizador: ${escapeHTML(ev.organizer_name)}</div>` : ""}
      ${attendees ? `<div class="ov-detail-row">Participantes: ${escapeHTML(attendees)}</div>` : ""}
      ${ev.join_url ? `<div class="ov-detail-row"><a href="${escapeHTML(ev.join_url)}" target="_blank" rel="noreferrer" class="ov-detail-link">Entrar na reunião</a></div>` : ""}
    `;
    return renderMiniItem(`rev-${i}`, "blue", escapeHTML(ev.title), fmtDate(ev.start), detail);
  }).join("");
}

/* ---------- Overview v2: Semana view ---------- */

function renderSemana(m365Events, googleEvents, bitrixTasks) {
  const grid = $("semana-grid");
  if (!grid) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((dow + 6) % 7));

  const allEvents = [...(m365Events || []), ...(googleEvents || [])];
  const tasks = (bitrixTasks?.items || []).filter(t => !t.done);
  const todayStr = todayISO();
  const dayNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  const cards = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const isToday = iso === todayStr;
    const dayEvents = allEvents.filter(e => (e.start || "").startsWith(iso));
    const dayTasks = tasks.filter(t => t.deadline && t.deadline.slice(0, 10) === iso);
    const overdueTasks = isToday ? tasks.filter(t => t.deadline && t.deadline.slice(0, 10) < iso) : [];
    const expanded = ovExpandedSemanaDay === iso;

    let detail = "";
    if (expanded) {
      const detailItems = [];
      dayEvents.forEach(ev => detailItems.push(`<div class="ov-semana-detail-item">${escapeHTML(fmtTime(ev.start))} ${escapeHTML(ev.title)}</div>`));
      dayTasks.forEach(t => detailItems.push(`<div class="ov-semana-detail-item">${escapeHTML(t.title)}</div>`));
      overdueTasks.forEach(t => detailItems.push(`<div class="ov-semana-detail-item" style="color:var(--red)">${escapeHTML(t.title)}</div>`));
      detail = detailItems.length > 0
        ? `<div class="ov-semana-detail">${detailItems.join("")}</div>`
        : `<div class="ov-semana-detail"><div class="ov-mini-empty">Dia livre</div></div>`;
    }

    cards.push(`
      <div class="ov-semana-card${isToday ? " today" : ""}${expanded ? " expanded" : ""}" data-semana-day="${iso}">
        <div class="ov-semana-day">${dayNames[d.getDay()]}</div>
        <div class="ov-semana-date">${d.getDate()}</div>
        ${isToday ? '<div class="ov-semana-today-label">Hoje</div>' : ""}
        <div class="ov-semana-stats">
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

/* ---------- Overview v2: Daily Pulse ---------- */

function renderDailyPulse(meta, m365Events, bitrixTasks) {
  const el = $("daily-pulse");
  if (!el) return;
  const m = meta?.metrics || {};
  const parts = [];
  const totalUnread = (m.unread_emails || 0) + (m.outlook_unread || 0);
  const totalEvents = m.m365_events_today || m.events_today || 0;
  const openTasks = m.bitrix_open_tasks || 0;
  if (totalEvents > 0) parts.push(`${totalEvents} compromisso${totalEvents > 1 ? "s" : ""}`);
  if (openTasks > 0) parts.push(`${openTasks} tarefas Bitrix abertas`);
  if (totalUnread > 0) parts.push(`${totalUnread} email${totalUnread > 1 ? "s" : ""} não lido${totalUnread > 1 ? "s" : ""}`);
  el.textContent = parts.length > 0 ? parts.join(" · ") : "Dia tranquilo.";
}

/* ---------- Overview v2: Toggle ---------- */

function applyOvView() {
  const view = getOvView();
  const hojeEl = $("view-hoje");
  const semanaEl = $("view-semana");
  if (hojeEl) hojeEl.classList.toggle("hidden", view !== "hoje");
  if (semanaEl) semanaEl.classList.toggle("hidden", view !== "semana");
  document.querySelectorAll(".ov-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.ovView === view);
  });
}

/* ---------- Overview v2: main render ---------- */

function renderOverview(datasets) {
  const meta = datasets.meta || {};
  const m365Cal = datasets.m365_calendar || [];
  const googleCal = datasets.calendar || [];
  const bitrix = datasets.bitrix_tasks || {};
  const outlookInbox = datasets.outlook_inbox || [];
  const gmailInbox = datasets.emails_inbox || [];
  const gmailSent = datasets.emails_sent || [];
  const projects = datasets.projects || [];

  renderDailyPulse(meta, m365Cal, bitrix);
  renderFocus();
  renderAgendaHoje(m365Cal, googleCal);
  renderTarefasDia(bitrix);
  renderCaixaAcao(outlookInbox, gmailInbox);
  renderAguardando(null, gmailSent);
  renderProjetosParados(projects);
  renderDecisoesDia(m365Cal, googleCal);
  renderRevisoes(m365Cal, googleCal);
  renderSemana(m365Cal, googleCal, bitrix);
  applyOvView();
}

/* ---------- Load + Sync ---------- */

async function loadAll() {
  try {
    const [datasets] = await Promise.all([loadBootstrap(), loadFocus()]);
    const meta = datasets.meta || null;
    const pending = datasets.pending || [];
    const bitrix = datasets.bitrix_tasks || null;
    const emails = datasets.emails_inbox || [];
    const sent = datasets.emails_sent || [];
    const calendar = datasets.calendar || [];
    const projects = datasets.projects || [];
    const agents = datasets.agents || [];
    const people = datasets.people || [];

    renderMeta(meta);
    renderOverview(datasets);
    renderPending(pending);
    renderBitrix(bitrix);
    hydrateBitrixAccess((bitrix?.items || []).slice(0, 20));
    renderEmails(emails);
    renderEmailsSent(sent);
    renderCalendar(calendar);
    renderProjects(projects);
    renderAgents(agents);
    renderTeam(people);
  } catch (error) {
    console.error(error);
    renderMeta(null);
    renderPending([]);
    renderBitrix(null);
    renderEmails([]);
    renderEmailsSent([]);
    renderCalendar([]);
    renderProjects([]);
    renderAgents([]);
    renderTeam([]);
  }
}

async function handleBitrixAction(action, taskId, button) {
  const item = button.closest(".bitrix-item");
  if (!item) return;

  try {
    setBitrixBusy(taskId, true);
    setBitrixFeedback(taskId, "Salvando no Bitrix…");

    if (action === "save") {
      const title = item.querySelector(".bitrix-title-input")?.value?.trim() || "";
      const deadlineLocal = item.querySelector(".bitrix-deadline-input")?.value || "";
      await postJSON(API_BITRIX_UPDATE, {
        task_id: Number(taskId),
        title,
        deadline: localInputValueToIso(deadlineLocal),
      });
      delete bitrixAccessCache[String(taskId)];
      await loadAll();
      setBitrixFeedback(taskId, "Tarefa atualizada.", "ok");
      return;
    }

    await postJSON(API_BITRIX_ACTION, {
      task_id: Number(taskId),
      action,
    });
    delete bitrixAccessCache[String(taskId)];
    await loadAll();
    setBitrixFeedback(taskId, "Ação executada no Bitrix.", "ok");
  } catch (error) {
    console.error(error);
    setBitrixFeedback(taskId, error.message || "Falha ao falar com o Bitrix.", "err");
  } finally {
    setBitrixBusy(taskId, false);
  }
}

async function runSync() {
  const btn = $("sync-btn");
  const status = $("sync-status");
  btn.disabled = true;
  btn.classList.add("syncing");
  status.textContent = "Sincronizando…";
  status.className = "sync-status";

  try {
    const r = await fetch(API_SYNC, { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      status.textContent = "Sync ok";
      status.className = "sync-status ok";
      await loadAll();
    } else {
      console.error("Sync falhou:", data);
      status.textContent = "Falha no sync";
      status.className = "sync-status err";
    }
  } catch (e) {
    console.error(e);
    status.textContent = "Erro de rede";
    status.className = "sync-status err";
  } finally {
    btn.disabled = false;
    btn.classList.remove("syncing");
  }
}

/* ---------- Init ---------- */

function initNav() {
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-item")
        .forEach((x) => x.classList.remove("active"));
      a.classList.add("active");
    });
  });
}

function initBitrixActions() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-bitrix-action]");
    if (!button) return;
    const item = button.closest(".bitrix-item");
    if (!item) return;
    const taskId = item.dataset.taskId;
    if (!taskId) return;
    handleBitrixAction(button.dataset.bitrixAction, taskId, button);
  });
}

function initEmailModal() {
  ensureEmailReplyUI();
  document.addEventListener("click", (event) => {
    const outlookTrigger = event.target.closest("[data-outlook-id]");
    if (outlookTrigger) {
      openOutlookEmailModal(outlookTrigger.dataset.outlookId);
      return;
    }

    const trigger = event.target.closest("[data-email-id][data-email-kind]");
    if (trigger) {
      openEmailModal(trigger.dataset.emailKind, trigger.dataset.emailId);
      return;
    }

    if (
      event.target.id === "email-modal-close" ||
      event.target.id === "email-modal-overlay"
    ) {
      closeEmailModal();
      return;
    }

    if (
      event.target.id === "compose-modal-close" ||
      event.target.id === "compose-modal-overlay"
    ) {
      closeComposeModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      document.activeElement?.id === "email-reply-input"
    ) {
      sendEmailReply();
      return;
    }
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      document.activeElement?.id === "compose-body"
    ) {
      sendNewEmail();
      return;
    }
    if (event.key === "Escape") {
      closeEmailModal();
      closeComposeModal();
    }
  });

  const sendButton = $("email-reply-send");
  if (sendButton) {
    sendButton.addEventListener("click", sendEmailReply);
  }
  const sendAllButton = $("email-reply-all-send");
  if (sendAllButton) {
    sendAllButton.addEventListener("click", sendEmailReplyAll);
  }
  const suggestBtn = $("email-suggest-btn");
  if (suggestBtn) {
    suggestBtn.addEventListener("click", handleSuggestReply);
  }
  const newEmailButton = $("new-email-btn");
  if (newEmailButton) {
    newEmailButton.addEventListener("click", openComposeModal);
  }
  const composeSendButton = $("compose-send");
  if (composeSendButton) {
    composeSendButton.addEventListener("click", sendNewEmail);
  }
}

function initOverview() {
  // Toggle Hoje/Semana
  document.querySelectorAll(".ov-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      setOvView(btn.dataset.ovView);
      applyOvView();
    });
  });
  applyOvView();

  // Focus actions
  const suggestBtn = $("focus-suggest-btn");
  if (suggestBtn) suggestBtn.addEventListener("click", handleFocusSuggest);

  const addBtn = $("focus-add-btn");
  if (addBtn) addBtn.addEventListener("click", handleFocusAdd);

  const addInput = $("focus-add-input");
  if (addInput) {
    addInput.addEventListener("keydown", e => {
      if (e.key === "Enter") handleFocusAdd();
    });
  }

  // Focus toggle/remove delegation
  document.addEventListener("click", e => {
    const toggleEl = e.target.closest("[data-focus-toggle]");
    if (toggleEl) {
      handleFocusToggle(toggleEl.dataset.focusToggle);
      return;
    }
    const removeEl = e.target.closest("[data-focus-remove]");
    if (removeEl) {
      handleFocusRemove(removeEl.dataset.focusRemove);
      return;
    }
  });

  // Change event for checkboxes (in case click doesn't fire)
  document.addEventListener("change", e => {
    if (e.target.matches("[data-focus-toggle]")) {
      handleFocusToggle(e.target.dataset.focusToggle);
    }
  });

  // Mini-item click -> expand detail
  document.addEventListener("click", e => {
    const mini = e.target.closest("[data-mini-id]");
    if (mini) {
      toggleMiniDetail(mini.dataset.miniId);
      return;
    }
  });

  // Semana card click -> expand
  document.addEventListener("click", e => {
    const card = e.target.closest("[data-semana-day]");
    if (!card) return;
    const day = card.dataset.semanaDay;
    ovExpandedSemanaDay = ovExpandedSemanaDay === day ? null : day;
    // Re-render semana (need datasets cached)
    loadAll();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setGreeting();
  setToday();
  initNav();
  initOverview();
  initBitrixActions();
  initEmailModal();
  $("sync-btn").addEventListener("click", runSync);
  loadAll();
});
