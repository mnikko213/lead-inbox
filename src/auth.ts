import { utcNow } from "./db";
import type { Env } from "./types";

export const SESSION_COOKIE = "lead_inbox_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 7;

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const encoder = new TextEncoder();

/** Compares by hash so timing reveals nothing about the secret, whatever its length. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

/** Fails closed: with no API_TOKEN configured, no token can be right. */
export async function isValidBearer(env: Env, header: string | undefined): Promise<boolean> {
  if (!env.API_TOKEN || !header) return false;
  const match = header.match(/^Bearer +(\S+)$/i);
  return match ? safeEqual(match[1], env.API_TOKEN) : false;
}

export async function isValidOwnerLogin(env: Env, username: string, password: string): Promise<boolean> {
  if (!env.OWNER_PASSWORD) return false;
  const [userOk, passwordOk] = await Promise.all([
    safeEqual(username, env.OWNER_USERNAME || "owner"),
    safeEqual(password, env.OWNER_PASSWORD),
  ]);
  return userOk && passwordOk;
}

/** Tied to the password, so changing the password signs out every session. */
async function signature(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${env.SESSION_SECRET}:${env.OWNER_PASSWORD}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

export async function createSession(env: Env): Promise<string> {
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  return `${expires}.${encodeURIComponent(await signature(env, expires))}`;
}

export async function isValidSession(env: Env, cookie: string | undefined): Promise<boolean> {
  if (!cookie || !env.SESSION_SECRET || !env.OWNER_PASSWORD) return false;
  const dot = cookie.indexOf(".");
  if (dot < 1) return false;
  const expires = cookie.slice(0, dot);
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  return safeEqual(cookie.slice(dot + 1), encodeURIComponent(await signature(env, expires)));
}

const windowStart = () => utcNow(new Date(Date.now() - FAILURE_WINDOW_MS));

export async function isLoginBlocked(db: D1Database, ip: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM login_failures WHERE ip = ? AND failed_at > ?")
    .bind(ip, windowStart())
    .first<{ total: number }>();
  return (row?.total ?? 0) >= MAX_FAILURES;
}

export async function recordLoginFailure(db: D1Database, ip: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM login_failures WHERE failed_at <= ?").bind(windowStart()),
    db.prepare("INSERT INTO login_failures (ip, failed_at) VALUES (?, ?)").bind(ip, utcNow()),
  ]);
}

export async function clearLoginFailures(db: D1Database, ip: string): Promise<void> {
  await db.prepare("DELETE FROM login_failures WHERE ip = ?").bind(ip).run();
}
