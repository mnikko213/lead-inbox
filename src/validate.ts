import { SERVICES, STATUSES, type Service, type Status } from "./types";

export const LIMITS = { name: 100, email: 254, phone: 50, message: 2000, note: 5000 };
/** Larger bodies cannot be valid: 2000 characters of message fits well inside this. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface NewLeadInput {
  name: string;
  email: string;
  phone: string;
  service: Service;
  message: string;
}

export interface LeadPatch {
  status?: Status;
  note?: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Counts characters as people do, so one emoji is one character rather than two. */
const charCount = (value: string) => [...value].length;

const isBlank = (value: string) => value.trim() === "";

/**
 * NUL and unpaired surrogates cannot be stored and returned unchanged, so they
 * are refused instead of being silently altered.
 */
const isStorable = (value: string) => !value.includes("\u0000") && value.isWellFormed();

const EMAIL_SHAPE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(email: string): boolean {
  if (email.length > LIMITS.email || !EMAIL_SHAPE.test(email)) return false;
  const local = email.slice(0, email.lastIndexOf("@"));
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const topLevel = email.slice(email.lastIndexOf(".") + 1);
  return topLevel.length >= 2 && !/^\d+$/.test(topLevel);
}

/** Parses a raw request body into a plain object. */
export function parseJsonObject(raw: string): Result<Record<string, unknown>> {
  if (raw.length > MAX_BODY_BYTES) return fail("Request body is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("Request body must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("Request body must be a JSON object.");
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function requiredText(body: Record<string, unknown>, field: string, max: number): Result<string> {
  const value = body[field];
  if (value === undefined || value === null) return fail(`${field} is required.`);
  if (typeof value !== "string") return fail(`${field} must be a string.`);
  if (isBlank(value)) return fail(`${field} is required.`);
  if (charCount(value) > max) return fail(`${field} must be ${max} characters or fewer.`);
  if (!isStorable(value)) return fail(`${field} contains an invalid character.`);
  return { ok: true, value };
}

/** Validates a new lead. Values are returned untouched: no trimming, no escaping. */
export function validateNewLead(body: Record<string, unknown>): Result<NewLeadInput> {
  const name = requiredText(body, "name", LIMITS.name);
  if (!name.ok) return name;

  const email = requiredText(body, "email", LIMITS.email);
  if (!email.ok) return email;
  if (!isValidEmail(email.value)) return fail("email must be a valid email address.");

  let phone = "";
  if (body.phone !== undefined && body.phone !== null) {
    if (typeof body.phone !== "string") return fail("phone must be a string.");
    if (charCount(body.phone) > LIMITS.phone) return fail(`phone must be ${LIMITS.phone} characters or fewer.`);
    if (!isStorable(body.phone)) return fail("phone contains an invalid character.");
    phone = body.phone;
  }

  const service = body.service;
  if (service === undefined || service === null) return fail("service is required.");
  if (typeof service !== "string" || !SERVICES.includes(service as Service)) {
    return fail(`service must be one of: ${SERVICES.join(", ")}.`);
  }

  const message = requiredText(body, "message", LIMITS.message);
  if (!message.ok) return message;

  return {
    ok: true,
    value: { name: name.value, email: email.value, phone, service: service as Service, message: message.value },
  };
}

/** Validates a PATCH. The whole patch is checked first, so a bad status never saves a note. */
export function validatePatch(body: Record<string, unknown>): Result<LeadPatch> {
  const patch: LeadPatch = {};

  if ("status" in body) {
    if (typeof body.status !== "string" || !STATUSES.includes(body.status as Status)) {
      return fail(`status must be one of: ${STATUSES.join(", ")}.`);
    }
    patch.status = body.status as Status;
  }

  if ("note" in body) {
    if (typeof body.note !== "string") return fail("note must be a string.");
    if (charCount(body.note) > LIMITS.note) return fail(`note must be ${LIMITS.note} characters or fewer.`);
    if (!isStorable(body.note)) return fail("note contains an invalid character.");
    patch.note = body.note;
  }

  if (patch.status === undefined && patch.note === undefined) {
    return fail("Send status, note, or both.");
  }
  return { ok: true, value: patch };
}

/** Accepts only plain positive integers from a URL, so "12abc" and "1.5" are not found. */
export function parseId(raw: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
