// Customer text only ever reaches the page through textContent (see h below),
// so markup typed into the form shows as plain text and cannot run.

const STATUSES = ["new", "contacted", "won", "lost"];
const CATEGORIES = ["booking", "question", "complaint", "other"];
const POLL_MS = 20_000;
const LIST_LIMIT = 200;

const state = {
  leads: [],
  counts: { status: {}, category: {} },
  status: "",
  category: "",
  current: null,
  snapshot: "",
  newestSeen: null,
  requestNumber: 0,
};

const $ = (id) => document.getElementById(id);
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function timeAgo(iso) {
  const seconds = Math.round((new Date(iso) - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour");
  return relativeFormat.format(Math.round(hours / 24), "day");
}
const fullDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

let toastTimer;
function toast(text) {
  const box = $("toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

async function ownerFetch(path, init) {
  const response = await fetch(path, init);
  if (response.status === 401) {
    location.assign("/login");
    throw new Error("Signed out");
  }
  return response;
}

/* ---------- URL: filters and the open lead survive a refresh ---------- */

function readUrl() {
  const params = new URLSearchParams(location.search);
  const status = params.get("status");
  const category = params.get("category");
  state.status = STATUSES.includes(status) ? status : "";
  state.category = CATEGORIES.includes(category) ? category : "";
  return Number(params.get("lead")) || null;
}

function urlFor(leadId) {
  const params = new URLSearchParams();
  if (state.status) params.set("status", state.status);
  if (state.category) params.set("category", state.category);
  if (leadId) params.set("lead", leadId);
  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

/* ---------- Data ---------- */

async function load({ announce = false } = {}) {
  const number = ++state.requestNumber;
  const params = new URLSearchParams();
  if (state.status) params.set("status", state.status);
  if (state.category) params.set("category", state.category);

  try {
    const response = await ownerFetch(`/owner/leads?${params}`);
    if (!response.ok) throw new Error("Load failed");
    const data = await response.json();
    if (number !== state.requestNumber) return;
    $("load-error").hidden = true;

    const newest = data.leads[0]?.id ?? 0;
    if (announce && state.newestSeen !== null && newest > state.newestSeen) {
      const count = data.leads.filter((lead) => lead.id > state.newestSeen).length;
      toast(count === 1 ? "1 new lead" : `${count} new leads`);
    }
    state.newestSeen = Math.max(state.newestSeen ?? 0, newest);

    const snapshot = JSON.stringify(data);
    if (snapshot === state.snapshot) return;
    state.snapshot = snapshot;
    state.leads = data.leads;
    state.counts = data.counts;
    render();
  } catch (error) {
    if (error.message === "Signed out" || number !== state.requestNumber) return;
    $("load-error").textContent = "Leads could not be loaded. Retrying shortly.";
    $("load-error").hidden = false;
  }
}

async function saveLead(id, patch) {
  const response = await ownerFetch(`/owner/leads/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Not saved.");
  return body;
}

/* ---------- Rendering ---------- */

function render() {
  renderStatusTabs();
  renderCategoryFilters();
  renderTickets();
  const fresh = state.current && state.leads.find((lead) => lead.id === state.current.id);
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(state.current) && !isNoteDirty()) {
    state.current = fresh;
    renderDetail();
  }
  const newCount = state.counts.status.new ?? 0;
  document.title = newCount ? `(${newCount}) Leads` : "Leads";
}

function setFilter(key, value) {
  state[key] = value;
  state.snapshot = "";
  history.replaceState(null, "", urlFor(state.current?.id));
  load();
}

function renderStatusTabs() {
  const total = Object.values(state.counts.status).reduce((sum, value) => sum + value, 0);
  const tab = (value, label, count) =>
    h("button", {
      type: "button",
      className: "status-tab",
      "aria-current": state.status === value ? "true" : null,
      onclick: () => setFilter("status", value),
    }, label, h("span", { className: "count" }, count));
  $("status-tabs").replaceChildren(
    tab("", "All", total),
    ...STATUSES.map((status) => tab(status, capitalize(status), state.counts.status[status] ?? 0)),
  );
}

function renderCategoryFilters() {
  const chip = (value, label, count) =>
    h("button", {
      type: "button",
      className: "chip",
      "aria-pressed": String(state.category === value),
      onclick: () => setFilter("category", value),
    }, count === undefined ? label : `${label} ${count}`);
  $("category-filters").replaceChildren(
    chip("", "All types"),
    ...CATEGORIES.map((category) => chip(category, capitalize(category), state.counts.category[category] ?? 0)),
  );
}

const urgencyLabel = { high: "High urgency", normal: "Normal urgency", low: "Low urgency" };
const serviceLabel = (service) => (service === "other" ? "Other service" : capitalize(service));

function ticket(lead) {
  return h("li", {},
    h("button", {
      type: "button",
      className: `ticket-row paper-${lead.urgency}`,
      "aria-current": state.current?.id === lead.id ? "true" : null,
      "data-id": lead.id,
      onclick: () => openLead(lead),
    },
      h("span", { className: "ticket-top" },
        h("span", { className: "ticket-name" }, lead.name),
        h("span", { className: "ticket-time", title: fullDate(lead.created_at) }, timeAgo(lead.created_at)),
      ),
      h("span", { className: "ticket-message" }, lead.message),
      h("span", { className: "ticket-bottom" },
        h("span", { className: "ticket-tags" },
          h("span", {}, urgencyLabel[lead.urgency]),
          h("span", {}, capitalize(lead.category)),
          h("span", {}, serviceLabel(lead.service)),
        ),
        h("span", { className: `stamp stamp-${lead.status}` }, capitalize(lead.status)),
      ),
    ),
  );
}

function renderTickets() {
  const focusedId = document.activeElement?.dataset?.id;
  $("ticket-list").replaceChildren(...state.leads.map(ticket));
  if (focusedId) document.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();

  const empty = $("empty");
  empty.hidden = state.leads.length > 0;
  if (!state.leads.length) {
    const filtered = state.status || state.category;
    empty.replaceChildren(
      h("h2", {}, filtered ? "Nothing matches these filters" : "No leads yet"),
      filtered
        ? h("button", { type: "button", className: "secondary", onclick: clearFilters }, "Clear filters")
        : h("p", {}, "Requests from your form land here. ", h("a", { href: "/" }, "Open the form")),
    );
  }

  const limit = $("list-limit");
  limit.hidden = state.leads.length < LIST_LIMIT;
  limit.textContent = `Showing the newest ${LIST_LIMIT} leads. Filter to narrow the list.`;
}

function clearFilters() {
  state.status = "";
  state.category = "";
  state.snapshot = "";
  history.replaceState(null, "", urlFor(state.current?.id));
  load();
}

/* ---------- Detail panel ---------- */

const isNoteDirty = () => {
  const note = $("note");
  return Boolean(note && state.current && note.value !== state.current.note);
};

async function saveNoteIfDirty() {
  if (!isNoteDirty()) return;
  const lead = state.current;
  const value = $("note").value;
  try {
    const saved = await saveLead(lead.id, { note: value });
    mergeLead(saved);
  } catch (error) {
    toast(`Note for ${lead.name} not saved. ${error.message}`);
  }
}

function mergeLead(saved) {
  if (state.current?.id === saved.id) state.current = saved;
  state.leads = state.leads.map((lead) => (lead.id === saved.id ? saved : lead));
}

function renderPlaceholder() {
  $("detail").replaceChildren(
    h("div", { className: "detail-placeholder" }, h("p", {}, "Choose a lead to read the full message and update it.")),
  );
}

function contactLinks(lead) {
  const digits = lead.phone.replace(/[^\d+]/g, "");
  const email = encodeURIComponent(lead.email).replace(/%40/g, "@");
  return h("div", { className: "contact-links" },
    digits.replace(/\D/g, "").length >= 3 && h("a", { className: "contact-link", href: `tel:${digits}` }, "Call ", lead.phone),
    lead.phone && digits.replace(/\D/g, "").length < 3 && h("span", { className: "contact-link plain" }, lead.phone),
    h("a", { className: "contact-link", href: `mailto:${email}` }, "Email ", lead.email),
  );
}

function statusControl(lead) {
  return h("div", { className: "status-control", role: "group", "aria-labelledby": "status-label" },
    STATUSES.map((status) =>
      h("button", {
        type: "button",
        className: "status-option",
        "aria-pressed": String(lead.status === status),
        onclick: () => changeStatus(status),
      }, capitalize(status)),
    ),
  );
}

async function changeStatus(status) {
  const previous = state.current;
  if (!previous || previous.status === status) return;
  state.current = { ...previous, status };
  renderDetail({ pressStamp: true, keepNote: $("note").value });
  try {
    const saved = await saveLead(previous.id, { status });
    mergeLead(saved);
    state.snapshot = "";
    renderTickets();
    load();
  } catch (error) {
    if (state.current?.id === previous.id) {
      state.current = previous;
      renderDetail();
    }
    toast(`Status not saved. ${error.message}`);
  }
}

const sortedByText = { ai: "Sorted by AI", rules: "Sorted by keyword rules" };
const webhookText = {
  delivered: "CRM notified",
  pending: "CRM notification retrying",
  failed: "CRM notification failed after 6 tries",
};

function renderDetail({ pressStamp = false, keepNote } = {}) {
  const lead = state.current;
  document.body.classList.toggle("detail-open", Boolean(lead));
  if (!lead) {
    renderPlaceholder();
    return;
  }

  const savedText = h("span", { className: "note-saved", id: "note-saved", role: "status" });
  const note = h("textarea", { id: "note", rows: "4", placeholder: "Called back, left a voicemail" });
  note.value = keepNote ?? lead.note;

  const form = h("form", {
    className: "note-form",
    onsubmit: async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      savedText.textContent = "";
      try {
        const saved = await saveLead(lead.id, { note: note.value });
        mergeLead(saved);
        savedText.textContent = "Note saved";
        state.snapshot = "";
        renderTickets();
      } catch (error) {
        savedText.textContent = `Not saved. ${error.message}`;
      } finally {
        button.disabled = false;
      }
    },
  },
    h("label", { for: "note" }, "Note"),
    note,
    h("div", { className: "note-actions" },
      h("button", { className: "secondary", type: "submit" }, "Save note"),
      savedText,
    ),
  );

  $("detail").replaceChildren(
    h("article", { className: `detail-sheet paper-${lead.urgency}` },
      h("button", { type: "button", className: "link-button detail-close", onclick: closeLead }, "Back to leads"),
      h("div", { className: "detail-head" },
        h("h2", { id: "detail-title", tabindex: "-1" }, lead.name),
        h("span", { className: `stamp stamp-${lead.status}${pressStamp ? " stamp-press" : ""}` }, capitalize(lead.status)),
      ),
      h("p", { className: "detail-tags" }, `${urgencyLabel[lead.urgency]}, ${lead.category}, ${serviceLabel(lead.service).toLowerCase()}`),
      contactLinks(lead),
      h("p", { className: "detail-message" }, lead.message),
      h("h3", { id: "status-label" }, "Status"),
      statusControl(lead),
      form,
      h("dl", { className: "detail-facts" },
        h("div", {}, h("dt", {}, "Received"), h("dd", {}, fullDate(lead.created_at))),
        h("div", {}, h("dt", {}, "Request number"), h("dd", {}, lead.id)),
        h("div", {}, h("dt", {}, "Sorting"), h("dd", {}, sortedByText[lead.sorted_by])),
        lead.webhook_status && h("div", {}, h("dt", {}, "CRM"), h("dd", {}, webhookText[lead.webhook_status])),
      ),
    ),
  );
}

async function openLead(lead, { push = true } = {}) {
  if (state.current?.id === lead.id) return;
  await saveNoteIfDirty();
  state.current = state.leads.find((item) => item.id === lead.id) ?? lead;
  if (push) history.pushState(null, "", urlFor(lead.id));
  renderDetail();
  renderTickets();
  $("detail-title").focus();
}

async function closeLead({ push = true } = {}) {
  await saveNoteIfDirty();
  const id = state.current?.id;
  state.current = null;
  if (push) history.pushState(null, "", urlFor(null));
  renderDetail();
  renderTickets();
  if (id) document.querySelector(`[data-id="${id}"]`)?.focus();
}

/* ---------- Start ---------- */

$("sign-out").addEventListener("click", async () => {
  await saveNoteIfDirty();
  await fetch("/owner/logout", { method: "POST" });
  location.assign("/login");
});

window.addEventListener("popstate", () => {
  const leadId = readUrl();
  state.snapshot = "";
  load().then(() => {
    const lead = leadId && state.leads.find((item) => item.id === leadId);
    if (lead) openLead(lead, { push: false });
    else if (state.current) closeLead({ push: false });
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.current) closeLead();
});

setInterval(() => {
  if (document.visibilityState === "visible") load({ announce: true });
}, POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load({ announce: true });
});

const initialLead = readUrl();
renderDetail();
await load();
if (initialLead) {
  const lead = state.leads.find((item) => item.id === initialLead);
  if (lead) openLead(lead, { push: false });
}
