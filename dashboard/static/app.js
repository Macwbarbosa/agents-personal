/* ========= Sr. Bazinga Dashboard ========= */

const DATA_BASE = "/data";
const API_SYNC = "/api/sync";

const $ = (id) => document.getElementById(id);

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

/* ---------- Renderizações ---------- */

function renderMeta(meta) {
  if (!meta) {
    $("sync-status").textContent = "Sem dados — rode sync";
    $("sync-status").className = "sync-status err";
    return;
  }
  const m = meta.metrics || {};
  $("metric-pending").textContent = m.pending_tasks ?? "–";
  $("metric-emails").textContent = m.unread_emails ?? "–";
  $("metric-events").textContent = m.events_today ?? "–";
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

  list.innerHTML = emails
    .map((e) => {
      const fromName = (e.from || "").replace(/<.*>/, "").trim() || e.from;
      return `
      <div class="list-item">
        <div class="list-dot ${e.unread ? "orange" : "muted"}"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(e.subject || "(sem assunto)")}</div>
          <div class="list-sub">${escapeHTML(fromName)} · ${escapeHTML(e.snippet || "")}</div>
        </div>
        <div class="list-meta">${escapeHTML((e.date || "").split(" ").slice(0, 4).join(" "))}</div>
      </div>
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
  list.innerHTML = emails
    .map((e) => {
      const toName = (e.to || "").replace(/<.*>/, "").trim() || e.to;
      return `
      <div class="list-item">
        <div class="list-dot blue"></div>
        <div class="list-body">
          <div class="list-title">${escapeHTML(e.subject || "(sem assunto)")}</div>
          <div class="list-sub">→ ${escapeHTML(toName)} · ${escapeHTML(e.snippet || "")}</div>
        </div>
        <div class="list-meta">${escapeHTML((e.date || "").split(" ").slice(0, 4).join(" "))}</div>
      </div>
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

      return `
      <div class="list-item${task.done ? " done" : ""}">
        <div class="list-dot ${dotClass}"></div>
        <div class="list-body">
          <div class="list-title">${link}</div>
          <div class="list-sub">${metaPieces.join("")}</div>
          <div class="list-sub">${ownerLine}</div>
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

/* ---------- Load + Sync ---------- */

async function loadAll() {
  const [meta, pending, bitrix, emails, sent, calendar, projects, agents, people] =
    await Promise.all([
      loadJSON("meta"),
      loadJSON("pending"),
      loadJSON("bitrix_tasks"),
      loadJSON("emails_inbox"),
      loadJSON("emails_sent"),
      loadJSON("calendar"),
      loadJSON("projects"),
      loadJSON("agents"),
      loadJSON("people"),
    ]);

  renderMeta(meta);
  renderPending(pending);
  renderBitrix(bitrix);
  renderEmails(emails);
  renderEmailsSent(sent);
  renderCalendar(calendar);
  renderProjects(projects);
  renderAgents(agents);
  renderTeam(people);
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

document.addEventListener("DOMContentLoaded", () => {
  setGreeting();
  setToday();
  initNav();
  $("sync-btn").addEventListener("click", runSync);
  loadAll();
});
