import { utcNow } from "./db";
import type { Env, Lead } from "./types";

const SEND_TIMEOUT_MS = 3000;
/** Minutes to wait before each retry. After the last one the delivery is marked failed. */
const RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360];
/** Each retry is one fetch plus one database write, and the free plan allows 50 per run. */
const RETRY_BATCH_SIZE = 20;

async function post(url: string, lead: Lead): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "lead.created", lead }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : "Request failed";
  }
}

async function recordOutcome(env: Env, leadId: number, attempts: number, error: string | null) {
  if (error === null) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_error = '' WHERE lead_id = ?")
      .bind(attempts, leadId)
      .run();
    return;
  }
  const delay = RETRY_DELAYS_MINUTES[attempts - 1];
  const status = delay === undefined ? "failed" : "pending";
  const next = utcNow(new Date(Date.now() + (delay ?? 0) * 60_000));
  await env.DB.prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE lead_id = ?")
    .bind(status, attempts, error.slice(0, 300), next, leadId)
    .run();
}

/** Sends the webhook once. Never throws: the lead is already saved and must stay saved. */
export async function sendLeadCreated(env: Env, lead: Lead): Promise<void> {
  if (!env.WEBHOOK_URL) return;
  try {
    await recordOutcome(env, lead.id, 1, await post(env.WEBHOOK_URL, lead));
  } catch (error) {
    console.error("Webhook bookkeeping failed:", error);
  }
}

/** Cron job: retries deliveries that failed and are due again. */
export async function retryDueWebhooks(env: Env): Promise<void> {
  if (!env.WEBHOOK_URL) return;
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.email, l.phone, l.service, l.message, l.category, l.urgency, l.status, l.note, l.created_at, w.attempts
     FROM webhook_deliveries w JOIN leads l ON l.id = w.lead_id
     WHERE w.status = 'pending' AND w.next_attempt_at <= ?
     ORDER BY w.next_attempt_at LIMIT ?`,
  )
    .bind(utcNow(), RETRY_BATCH_SIZE)
    .all<Lead & { attempts: number }>();

  for (const { attempts, ...lead } of results) {
    await recordOutcome(env, lead.id, attempts + 1, await post(env.WEBHOOK_URL, lead));
  }
}
