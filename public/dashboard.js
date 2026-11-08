// Customer text only ever reaches the page through textContent (see h below),
// so markup typed into the form shows as plain text and cannot run.

const STATUSES = ["new", "contacted", "won", "lost"];
const CATEGORIES = ["booking", "question", "complaint", "other"];
const POLL_MS = 20_000;
const LIST_LIMIT = 200;
const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  phone: ["M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"],
  mail: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "m22 6-10 7L2 6"],
  back: ["m15 18-6-6 6-6"],
};

const state = {
  leads: [],
  counts: { status: {}, category: {} },
  summary: { new_total: 0, new_high: 0 },
  status: "",
  category: "",
  search: "",
  current: null,
  snapshot: "",
  newestSeen: null,
  requestNumber: 0,
  savingStatus: false,
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

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
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
function toast(text, action) {
  const box = $("toast");
  box.replaceChildren(h("span", {}, text));
  if (action) {
    box.append(h("button", {
      type: "button",
      className: "toast-action",
      onclick: () => {
        box.hidden = true;
        action.run();
      },
    }, action.label));
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 8000 : 4000);
}

async function ownerFetch(path, init) {
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error("Check your connection and try again.");
  }
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
    if (snapshot === state.snapshot) {
      refreshTimes();
      return;
    }
    state.snapshot = snapshot;
    state.leads = data.leads;
    state.counts = data.counts;
    state.summary = data.summary;
    render();
  } catch (error) {
    if (error.message === "Signed out" || number !== state.requestNumber) return;
    $("load-error").textContent = "Leads could not be loaded. Retrying shortly.";
    $("load-error").hidden = false;
    $("ticket-list").setAttribute("aria-busy", "false");
    for (const row of document.querySelectorAll(".skeleton")) row.remove();
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
  renderSummary();
  renderStatusTabs();
  renderCategoryFilters();
  renderTickets();
  const fresh = state.current && state.leads.find((lead) => lead.id === state.current.id);
  const working = $("detail").contains(document.activeElement) || isNoteDirty();
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(state.current) && !working) {
    state.current = fresh;
    renderDetail();
  }
}

function renderSummary() {
  const { new_total: total, new_high: high } = state.summary;
  document.title = total ? `(${total}) Leads` : "Leads";
  const parts = [];
  if (total) parts.push(`${total} new`);
  if (high) parts.push(`${high} high urgency`);
  $("summary").textContent = parts.length ? parts.join(", ") : "All caught up";
}

function setFilter(key, value) {
  state[key] = value;
  state.snapshot = "";
  history.replaceState(null, "", urlFor(state.current?.id));
  renderStatusTabs();
  renderCategoryFilters();
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
    }, h("span", {}, label), h("span", { className: "count" }, count));
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
    }, label, count !== undefined && h("span", { className: "count" }, count));
  $("category-filters").replaceChildren(
    chip("", "Any type"),
    ...CATEGORIES.map((category) => chip(category, capitalize(category), state.counts.category[category] ?? 0)),
  );
}

const urgencyLabel = { high: "High urgency", normal: "Normal urgency", low: "Low urgency" };
const serviceLabel = (service) => (service === "other" ? "Other service" : capitalize(service));

function visibleLeads() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.leads;
  return state.leads.filter((lead) =>
    [lead.name, lead.email, lead.phone, lead.message, lead.note].some((value) => value.toLowerCase().includes(query)),
  );
}

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
        h("span", { className: "ticket-time", title: fullDate(lead.created_at), "data-time": lead.created_at }, timeAgo(lead.created_at)),
      ),
      h("span", { className: "ticket-message" }, lead.message),
      h("span", { className: "ticket-bottom" },
        h("span", { className: "ticket-tags" },
          lead.urgency !== "normal" && h("span", { className: `tag-${lead.urgency}` }, urgencyLabel[lead.urgency]),
          h("span", {}, capitalize(lead.category)),
          h("span", {}, serviceLabel(lead.service)),
          lead.note && h("span", {}, "Has note"),
        ),
        h("span", { className: `stamp stamp-${lead.status}` }, capitalize(lead.status)),
      ),
    ),
  );
}

function refreshTimes() {
  for (const element of document.querySelectorAll("[data-time]")) {
    element.textContent = timeAgo(element.dataset.time);
  }
}

function renderTickets() {
  const focusedId = document.activeElement?.dataset?.id;
  const leads = visibleLeads();
  const searching = Boolean(state.search.trim());
  $("ticket-list").replaceChildren(...leads.map(ticket));
  $("ticket-list").setAttribute("aria-busy", "false");
  if (focusedId) document.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();

  $("search-status").textContent = searching ? `${leads.length} ${leads.length === 1 ? "lead" : "leads"} found` : "";

  const empty = $("empty");
  empty.hidden = leads.length > 0;
  if (!leads.length) {
    const filtered = state.status || state.category || searching;
    empty.replaceChildren(
      h("h2", {}, filtered ? "Nothing matches" : "No leads yet"),
      filtered
        ? h("button", { type: "button", className: "secondary", onclick: clearFilters }, searching && !state.status && !state.category ? "Clear search" : "Clear filters")
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
  state.search = "";
  $("search").value = "";
  state.snapshot = "";
  history.replaceState(null, "", urlFor(state.current?.id));
  renderStatusTabs();
  renderCategoryFilters();
  load();
}

/* ---------- Detail panel ---------- */

const isNoteDirty = () => {
  const note = $("note");
  return Boolean(note && state.current && note.value !== state.current.note);
};

/** Returns false if an unsaved note could not be saved, so the caller can stay put. */
async function saveNoteIfDirty() {
  if (!isNoteDirty()) return true;
  const lead = state.current;
  try {
    mergeLead(await saveLead(lead.id, { note: $("note").value }));
    return true;
  } catch (error) {
    if (error.message !== "Signed out") toast(`Note not saved. ${error.message}`);
    return false;
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
  const callable = digits.replace(/\D/g, "").length >= 3;
  const email = encodeURIComponent(lead.email).replace(/%40/g, "@");
  return h("div", { className: "contact-links" },
    callable && h("a", { className: "contact-link", href: `tel:${digits}`, "aria-label": `Call ${lead.phone}` }, icon("phone"), h("span", {}, lead.phone)),
    lead.phone && !callable && h("span", { className: "contact-link plain" }, icon("phone"), h("span", {}, lead.phone)),
    h("a", { className: "contact-link", href: `mailto:${email}`, "aria-label": `Email ${lead.email}` }, icon("mail"), h("span", {}, lead.email)),
  );
}

function statusControl(lead) {
  return h("div", { className: "status-control", role: "group", "aria-labelledby": "status-label" },
    STATUSES.map((status) =>
      h("button", {
        type: "button",
        className: "status-option",
        "data-status": status,
        "aria-pressed": String(lead.status === status),
        onclick: () => changeStatus(status),
      }, capitalize(status)),
    ),
  );
}

/** Updates the stamp and buttons in place, so focus and any note being typed are left alone. */
function reflectStatus(status, press) {
  const detail = $("detail");
  detail.querySelector(".detail-head .stamp")?.replaceWith(
    h("span", { className: `stamp stamp-${status}${press ? " stamp-press" : ""}` }, capitalize(status)),
  );
  for (const option of detail.querySelectorAll(".status-option")) {
    option.setAttribute("aria-pressed", String(option.dataset.status === status));
  }
}

async function changeStatus(status) {
  const previous = state.current;
  if (!previous || previous.status === status || state.savingStatus) return;
  state.savingStatus = true;
  state.current = { ...previous, status };
  reflectStatus(status, true);
  try {
    mergeLead(await saveLead(previous.id, { status }));
    state.snapshot = "";
    renderTickets();
    load();
    toast(`Marked as ${status}`, { label: "Undo", run: () => undoStatus(previous.id, previous.status) });
  } catch (error) {
    if (state.current?.id === previous.id) {
      state.current = previous;
      reflectStatus(previous.status, false);
    }
    if (error.message !== "Signed out") toast(`Status not saved. ${error.message}`);
  } finally {
    state.savingStatus = false;
  }
}

async function undoStatus(id, status) {
  try {
    const saved = await saveLead(id, { status });
    const isOpen = state.current?.id === id;
    if (isOpen) state.current = { ...state.current, status: saved.status };
    state.leads = state.leads.map((lead) => (lead.id === id ? { ...lead, status: saved.status } : lead));
    if (isOpen) reflectStatus(saved.status, true);
    state.snapshot = "";
    renderTickets();
    load();
    toast(`Back to ${status}`);
  } catch (error) {
    if (error.message !== "Signed out") toast(`Undo failed. ${error.message}`);
  }
}

const sortedByText = { ai: "Sorted by AI", rules: "Sorted by keyword rules" };
const webhookText = {
  delivered: "CRM notified",
  pending: "CRM notification retrying",
  failed: "CRM notification failed after 6 tries",
};

function noteForm(lead) {
  const savedText = h("span", { className: "note-saved", role: "status" });
  const note = h("textarea", { id: "note", rows: "4", placeholder: "Called back, left a voicemail" });
  note.value = lead.note;
  const saveButton = h("button", { className: "secondary", type: "submit", disabled: true }, "Save note");

  note.addEventListener("input", () => {
    saveButton.disabled = note.value === state.current.note;
    savedText.textContent = "";
  });

  const form = h("form", {
    className: "note-form",
    onsubmit: async (event) => {
      event.preventDefault();
      if (!isNoteDirty()) return;
      saveButton.disabled = true;
      savedText.textContent = "Saving";
      try {
        mergeLead(await saveLead(lead.id, { note: note.value }));
        savedText.textContent = "Note saved";
        state.snapshot = "";
        renderTickets();
      } catch (error) {
        savedText.textContent = `Not saved. ${error.message}`;
        saveButton.disabled = false;
      }
    },
  },
    h("label", { for: "note" }, "Note"),
    note,
    h("div", { className: "note-actions" }, saveButton, savedText),
  );

  note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit();
  });
  return form;
}

function renderDetail() {
  const lead = state.current;
  document.body.classList.toggle("detail-open", Boolean(lead));
  if (!lead) {
    renderPlaceholder();
    return;
  }

  $("detail").replaceChildren(
    h("article", { className: `detail-sheet paper-${lead.urgency}` },
      h("div", { className: "detail-bar" },
        h("button", { type: "button", className: "link-button detail-close", onclick: () => closeLead() }, icon("back"), "Back to leads"),
      ),
      h("div", { className: "detail-head" },
        h("h2", { id: "detail-title", tabindex: "-1" }, lead.name),
        h("span", { className: `stamp stamp-${lead.status}` }, capitalize(lead.status)),
      ),
      h("p", { className: "detail-tags" }, `${urgencyLabel[lead.urgency]}, ${lead.category}, ${serviceLabel(lead.service).toLowerCase()}`),
      contactLinks(lead),
      h("p", { className: "detail-message" }, lead.message),
      h("h3", { id: "status-label" }, "Status"),
      statusControl(lead),
      noteForm(lead),
      h("dl", { className: "detail-facts" },
        h("div", {}, h("dt", {}, "Received"), h("dd", {}, fullDate(lead.created_at))),
        h("div", {}, h("dt", {}, "Request number"), h("dd", {}, lead.id)),
        h("div", {}, h("dt", {}, "Sorting"), h("dd", {}, sortedByText[lead.sorted_by])),
        lead.webhook_status && h("div", {}, h("dt", {}, "CRM"), h("dd", {}, webhookText[lead.webhook_status])),
      ),
    ),
  );
  $("detail").scrollTop = 0;
}

async function openLead(lead, { push = true } = {}) {
  if (state.current?.id === lead.id) return;
  if (!(await saveNoteIfDirty())) return;
  state.current = state.leads.find((item) => item.id === lead.id) ?? lead;
  if (push) history.pushState(null, "", urlFor(lead.id));
  renderDetail();
  renderTickets();
  $("detail-title").focus();
}

async function closeLead({ push = true } = {}) {
  if (!(await saveNoteIfDirty())) return;
  const id = state.current?.id;
  state.current = null;
  if (push) history.pushState(null, "", urlFor(null));
  renderDetail();
  renderTickets();
  if (id) document.querySelector(`[data-id="${id}"]`)?.focus();
}

/* ---------- Start ---------- */

$("sign-out").addEventListener("click", async () => {
  if (!(await saveNoteIfDirty())) return;
  await fetch("/owner/logout", { method: "POST" });
  location.assign("/login");
});

$("search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderTickets();
});

window.addEventListener("beforeunload", (event) => {
  if (isNoteDirty()) event.preventDefault();
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
  if (event.key === "Escape" && state.current && event.target.id !== "search") closeLead();
});

setInterval(() => {
  if (document.visibilityState === "visible") load({ announce: true });
}, POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load({ announce: true });
});

const initialLead = readUrl();
renderDetail();
renderStatusTabs();
renderCategoryFilters();
await load();
if (initialLead) {
  const lead = state.leads.find((item) => item.id === initialLead);
  if (lead) openLead(lead, { push: false });
}
