import type { Lead, Status, Category } from "./types";
import type { LeadPatch, NewLeadInput } from "./validate";
import type { Sorting } from "./classify";

export const LIST_LIMIT = 200;

const PUBLIC_COLUMNS = "id, name, email, phone, service, message, category, urgency, status, note, created_at";

/** Matches the brief's format exactly: 2026-11-07T09:30:00Z. */
export const utcNow = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export interface LeadFilters {
  status?: string;
  category?: string;
}

function whereClause(filters: LeadFilters): { sql: string; binds: string[] } {
  const parts: string[] = [];
  const binds: string[] = [];
  if (filters.status) {
    parts.push("status = ?");
    binds.push(filters.status);
  }
  if (filters.category) {
    parts.push("category = ?");
    binds.push(filters.category);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", binds };
}

/**
 * Saves the lead and, if a webhook is configured, its outbox row in one
 * transaction. Returns the lead and whether an outbox row exists.
 */
export async function insertLead(db: D1Database, input: NewLeadInput, sorting: Sorting, queueWebhook: boolean): Promise<Lead> {
  const now = utcNow();
  const insert = db
    .prepare(
      `INSERT INTO leads (name, email, phone, service, message, category, urgency, created_at, sorted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${PUBLIC_COLUMNS}`,
    )
    .bind(input.name, input.email, input.phone, input.service, input.message, sorting.category, sorting.urgency, now, sorting.sorted_by);

  if (!queueWebhook) {
    return (await insert.first<Lead>()) as Lead;
  }

  // A first retry time in the future stops the cron job racing the first send.
  const firstRetry = utcNow(new Date(Date.now() + 60_000));
  const [saved] = await db.batch<Lead>([
    insert,
    db
      .prepare("INSERT INTO webhook_deliveries (lead_id, next_attempt_at) VALUES (last_insert_rowid(), ?)")
      .bind(firstRetry),
  ]);
  return saved.results[0];
}

export async function listLeads(db: D1Database, filters: LeadFilters): Promise<Lead[]> {
  const { sql, binds } = whereClause(filters);
  const { results } = await db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM leads ${sql} ORDER BY id DESC LIMIT ?`)
    .bind(...binds, LIST_LIMIT)
    .all<Lead>();
  return results;
}

export async function getLead(db: D1Database, id: number): Promise<Lead | null> {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM leads WHERE id = ?`).bind(id).first<Lead>();
}

export async function updateLead(db: D1Database, id: number, patch: LeadPatch): Promise<Lead | null> {
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    binds.push(patch.note);
  }
  return db
    .prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ? RETURNING ${PUBLIC_COLUMNS}`)
    .bind(...binds, id)
    .first<Lead>();
}

export interface OwnerLead extends Lead {
  sorted_by: "ai" | "rules";
  webhook_status: "pending" | "delivered" | "failed" | null;
}

/** Dashboard view: the public lead plus internal details the owner can act on. */
export async function listOwnerLeads(db: D1Database, filters: LeadFilters): Promise<OwnerLead[]> {
  const { sql, binds } = whereClause(filters);
  const columns = PUBLIC_COLUMNS.split(", ").map((column) => `l.${column}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${columns}, l.sorted_by, w.status AS webhook_status
       FROM (SELECT * FROM leads ${sql} ORDER BY id DESC LIMIT ?) l
       LEFT JOIN webhook_deliveries w ON w.lead_id = l.id
       ORDER BY l.id DESC`,
    )
    .bind(...binds, LIST_LIMIT)
    .all<OwnerLead>();
  return results;
}

export async function getOwnerLead(db: D1Database, id: number): Promise<OwnerLead | null> {
  const columns = PUBLIC_COLUMNS.split(", ").map((column) => `l.${column}`).join(", ");
  return db
    .prepare(
      `SELECT ${columns}, l.sorted_by, w.status AS webhook_status
       FROM leads l LEFT JOIN webhook_deliveries w ON w.lead_id = l.id WHERE l.id = ?`,
    )
    .bind(id)
    .first<OwnerLead>();
}

/** Inbox-wide totals for the dashboard header. These ignore the current filters. */
export async function countInbox(db: D1Database) {
  const row = await db
    .prepare("SELECT SUM(status = 'new') AS new_total, SUM(status = 'new' AND urgency = 'high') AS new_high FROM leads")
    .first<{ new_total: number | null; new_high: number | null }>();
  return { new_total: row?.new_total ?? 0, new_high: row?.new_high ?? 0 };
}

/** Counts for filter tabs. Each facet respects the other facet's current filter. */
export async function countFacets(db: D1Database, filters: LeadFilters) {
  const byStatus = whereClause({ category: filters.category });
  const byCategory = whereClause({ status: filters.status });
  const [statusRows, categoryRows] = await db.batch<{ key: Status | Category; total: number }>([
    db.prepare(`SELECT status AS key, COUNT(*) AS total FROM leads ${byStatus.sql} GROUP BY status`).bind(...byStatus.binds),
    db.prepare(`SELECT category AS key, COUNT(*) AS total FROM leads ${byCategory.sql} GROUP BY category`).bind(...byCategory.binds),
  ]);
  const toMap = (rows: { key: string; total: number }[]) => Object.fromEntries(rows.map((row) => [row.key, row.total]));
  return { status: toMap(statusRows.results), category: toMap(categoryRows.results) };
}
