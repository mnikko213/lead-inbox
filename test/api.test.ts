import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { retryDueWebhooks } from "../src/webhook";
import type { Env, Lead } from "../src/types";

const TOKEN = "test-token";
const WEBHOOK = "https://hooks.test/inbox";

const baseEnv = {
  ...(env as unknown as Env),
  API_TOKEN: TOKEN,
  OWNER_USERNAME: "owner",
  OWNER_PASSWORD: "correct horse",
  SESSION_SECRET: "session-secret",
} as Env;

const AUTH = { Authorization: `Bearer ${TOKEN}` };
const valid = { name: "Ana Cruz", email: "ana@example.com", phone: "", service: "cleaning", message: "Can you come Tuesday?" };

async function call(path: string, init: RequestInit = {}, testEnv: Env = baseEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://inbox.test${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const post = (body: unknown, testEnv?: Env) =>
  call("/api/leads", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, testEnv);

const create = async (overrides: object = {}, testEnv?: Env) => (await (await post({ ...valid, ...overrides }, testEnv)).json()) as Lead;

const patch = (id: number | string, body: unknown, headers: HeadersInit = AUTH) =>
  call(`/api/leads/${id}`, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body), headers });

const list = async (query = "") => ((await (await call(`/api/leads${query}`, { headers: AUTH })).json()) as { leads: Lead[] }).leads;

afterEach(() => vi.restoreAllMocks());

describe("POST /api/leads", () => {
  it("returns 201 and exactly the documented lead shape", async () => {
    const response = await post(valid);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    const lead = (await response.json()) as Lead;
    expect(Object.keys(lead).sort()).toEqual(
      ["category", "created_at", "email", "id", "message", "name", "note", "phone", "service", "status", "urgency"].sort(),
    );
    expect(lead).toMatchObject({ ...valid, category: "booking", urgency: "normal", status: "new", note: "" });
    expect(typeof lead.id).toBe("number");
    expect(lead.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("does not need a token, and defaults a missing phone to an empty string", async () => {
    const { phone: _phone, ...withoutPhone } = valid;
    const response = await post(withoutPhone);
    expect(response.status).toBe(201);
    expect(((await response.json()) as Lead).phone).toBe("");
  });

  it.each([
    ["XSS", "<script>alert('x')</script><img src=x onerror=alert(1)>"],
    ["SQL", "Robert'); DROP TABLE leads;--"],
    ["emoji and accents", "Niño 🧹👩🏽‍🔧 José & \"friends\""],
    ["outer spaces and newlines", "  line one\n\tline two  \r\n"],
  ])("returns %s text exactly as typed", async (_label, text) => {
    const lead = await create({ name: text, message: text });
    expect(lead.name).toBe(text);
    expect(lead.message).toBe(text);
    const fetched = (await (await call(`/api/leads/${lead.id}`, { headers: AUTH })).json()) as Lead;
    expect(fetched.name).toBe(text);
    expect(fetched.message).toBe(text);
  });

  it("ignores attempts to set server-owned fields", async () => {
    const lead = await create({ id: 999, status: "won", note: "hacked", category: "other", urgency: "low", created_at: "2000-01-01T00:00:00Z", message: "Pipe burst, need help today" });
    expect(lead).toMatchObject({ status: "new", note: "", category: "booking", urgency: "high" });
    expect(lead.id).not.toBe(999);
    expect(lead.created_at).not.toContain("2000");
  });

  it("accepts values exactly at the limits, counting emoji as one character", async () => {
    expect((await post({ ...valid, name: "a".repeat(100), message: "b".repeat(2000) })).status).toBe(201);
    expect((await post({ ...valid, name: "🧹".repeat(100), message: "🧹".repeat(2000) })).status).toBe(201);
  });

  it.each([
    ["no name", { name: undefined }],
    ["blank name", { name: "   " }],
    ["null name", { name: null }],
    ["numeric name", { name: 42 }],
    ["101-character name", { name: "a".repeat(101) }],
    ["no email", { email: undefined }],
    ["email without @", { email: "ana.example.com" }],
    ["email without domain dot", { email: "ana@example" }],
    ["email with spaces", { email: " ana@example.com " }],
    ["email with double dots", { email: "a..b@example.com" }],
    ["email array", { email: ["ana@example.com"] }],
    ["numeric phone", { phone: 12345 }],
    ["no service", { service: undefined }],
    ["unknown service", { service: "plumbing" }],
    ["wrong-case service", { service: "Cleaning" }],
    ["no message", { message: undefined }],
    ["blank message", { message: "\n  \t" }],
    ["2001-character message", { message: "a".repeat(2001) }],
    ["NUL in message", { message: "a\u0000b" }],
    ["broken surrogate in name", { name: "a\ud83d" }],
  ])("returns 400 and an error for %s", async (_label, overrides) => {
    const response = await post({ ...valid, ...overrides });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.length).toBeGreaterThan(0);
  });

  it.each([
    ["broken JSON", "{not json"],
    ["empty body", ""],
    ["JSON array", "[1,2]"],
    ["JSON null", "null"],
    ["JSON string", '"hello"'],
    ["oversized body", JSON.stringify({ ...valid, message: "a".repeat(70000) })],
  ])("returns 400 instead of crashing on %s", async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });

  it("saves nothing when input is rejected", async () => {
    await post({ ...valid, email: "nope" });
    expect(await list()).toHaveLength(0);
  });
});

describe("GET /api/leads", () => {
  it("returns newest first, and at least the newest 100", async () => {
    for (let index = 0; index < 105; index++) await create({ message: `Message ${index}` });
    const leads = await list();
    expect(leads.length).toBeGreaterThanOrEqual(100);
    expect(leads[0].message).toBe("Message 104");
    expect(leads.map((lead) => lead.id)).toEqual([...leads.map((lead) => lead.id)].sort((a, b) => b - a));
  });

  it("filters by status, by category, and by both", async () => {
    const booking = await create({ message: "Can you come Tuesday?" });
    const question = await create({ message: "Do you work weekends?" });
    await patch(question.id, { status: "contacted" });

    expect((await list("?status=new")).map((lead) => lead.id)).toEqual([booking.id]);
    expect((await list("?category=question")).map((lead) => lead.id)).toEqual([question.id]);
    expect((await list("?status=contacted&category=question")).map((lead) => lead.id)).toEqual([question.id]);
    expect(await list("?status=new&category=question")).toEqual([]);
  });

  it("returns an empty list for a filter value nothing can match", async () => {
    await create();
    const response = await call("/api/leads?status=banana", { headers: AUTH });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ leads: [] });
  });
});

describe("GET and PATCH /api/leads/{id}", () => {
  it("gets one lead", async () => {
    const lead = await create();
    const response = await call(`/api/leads/${lead.id}`, { headers: AUTH });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(lead);
  });

  it("updates status, note, or both", async () => {
    const lead = await create();
    let response = await patch(lead.id, { status: "won" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...lead, status: "won" });

    response = await patch(lead.id, { note: "Called back" });
    expect(await response.json()).toEqual({ ...lead, status: "won", note: "Called back" });

    response = await patch(lead.id, { status: "lost", note: "<b>Went elsewhere</b>" });
    expect(await response.json()).toEqual({ ...lead, status: "lost", note: "<b>Went elsewhere</b>" });
  });

  it("lets a note be cleared", async () => {
    const lead = await create();
    await patch(lead.id, { note: "x" });
    expect(((await (await patch(lead.id, { note: "" })).json()) as Lead).note).toBe("");
  });

  it.each([
    ["unknown status", { status: "archived" }],
    ["wrong-case status", { status: "WON" }],
    ["null status", { status: null }],
    ["numeric note", { note: 1 }],
    ["nothing to change", {}],
    ["only unknown fields", { name: "Changed" }],
    ["broken JSON", "{oops"],
  ])("returns 400 for %s", async (_label, body) => {
    const lead = await create();
    const response = await patch(lead.id, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });

  it("changes nothing when any part of the patch is bad", async () => {
    const lead = await create();
    await patch(lead.id, { status: "nope", note: "should not save" });
    expect((await (await call(`/api/leads/${lead.id}`, { headers: AUTH })).json()) as Lead).toEqual(lead);
  });

  it("does not let PATCH change customer fields", async () => {
    const lead = await create();
    const updated = (await (await patch(lead.id, { status: "contacted", name: "Other", category: "other" })).json()) as Lead;
    expect(updated).toEqual({ ...lead, status: "contacted" });
  });

  it.each(["999999", "abc", "12abc", "1.5", "-1", "0", "99999999999999999999"])("returns 404 for id %s", async (id) => {
    expect((await call(`/api/leads/${id}`, { headers: AUTH })).status).toBe(404);
    expect((await patch(id, { status: "won" })).status).toBe(404);
  });
});

describe("authorization", () => {
  const protectedRoutes: [string, string, unknown?][] = [
    ["GET", "/api/leads"],
    ["GET", "/api/leads/1"],
    ["GET", "/api/leads/999999"],
    ["PATCH", "/api/leads/1", { status: "won" }],
  ];

  it.each(protectedRoutes)("%s %s returns 401 with no token", async (method, path, body) => {
    const response = await call(path, { method, body: body ? JSON.stringify(body) : undefined });
    expect(response.status).toBe(401);
    expect(await response.json()).toHaveProperty("error");
  });

  it.each(["Bearer wrong", "Bearer", "Basic dGVzdA==", TOKEN, `Bearer ${TOKEN}x`, `Bearer ${TOKEN} extra`])("rejects the header %s", async (header) => {
    expect((await call("/api/leads", { headers: { Authorization: header } })).status).toBe(401);
  });

  it("refuses every token when API_TOKEN is not set", async () => {
    const response = await call("/api/leads", { headers: { Authorization: "Bearer undefined" } }, { ...baseEnv, API_TOKEN: undefined });
    expect(response.status).toBe(401);
  });

  it("protects other methods and unknown API paths too", async () => {
    expect((await call("/api/leads/1", { method: "DELETE" })).status).toBe(401);
    expect((await call("/api/nothing")).status).toBe(401);
    expect((await call("/api/leads/1", { method: "DELETE", headers: AUTH })).status).toBe(405);
    expect((await call("/api/nothing", { headers: AUTH })).status).toBe(404);
  });

  it("does not accept the owner cookie on the Bearer API", async () => {
    const login = await call("/owner/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "correct horse" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect((await call("/api/leads", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("answers browser preflight requests for other teams", async () => {
    const response = await call("/api/leads", { method: "OPTIONS", headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("webhook", () => {
  const withHook = { ...baseEnv, WEBHOOK_URL: WEBHOOK } as Env;
  const delivery = (leadId: number) =>
    baseEnv.DB.prepare("SELECT * FROM webhook_deliveries WHERE lead_id = ?").bind(leadId).first<{ status: string; attempts: number }>();

  it("POSTs the documented JSON once when a lead is saved", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const lead = await create({}, withHook);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ event: "lead.created", lead });
    expect(await delivery(lead.id)).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("does not fire for rejected input", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await post({ ...valid, email: "bad" }, withHook);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["network failure", () => Promise.reject(new Error("connection refused"))],
    ["500 response", () => Promise.resolve(new Response("down", { status: 500 }))],
  ])("still saves the lead on %s, and queues a retry", async (_label, failure) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(failure);
    const response = await post(valid, withHook);
    expect(response.status).toBe(201);
    const lead = (await response.json()) as Lead;
    expect(await list()).toHaveLength(1);
    expect(await delivery(lead.id)).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("works with no WEBHOOK_URL at all", async () => {
    const send = vi.spyOn(globalThis, "fetch");
    expect((await post(valid)).status).toBe(201);
    expect(send).not.toHaveBeenCalled();
  });

  it("retries due deliveries and stops after success", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("down"));
    const lead = await create({}, withHook);
    await baseEnv.DB.prepare("UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00Z'").run();

    send.mockResolvedValue(new Response("ok"));
    await retryDueWebhooks(withHook);
    expect(await delivery(lead.id)).toMatchObject({ status: "delivered", attempts: 2 });
    expect(JSON.parse(send.mock.calls[1][1]?.body as string).lead.id).toBe(lead.id);

    await retryDueWebhooks(withHook);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry a delivery that is not due yet", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("down"));
    await create({}, withHook);
    await retryDueWebhooks(withHook);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last retry", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const lead = await create({}, withHook);
    for (let attempt = 0; attempt < 5; attempt++) {
      await baseEnv.DB.prepare("UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00Z'").run();
      await retryDueWebhooks(withHook);
    }
    expect(await delivery(lead.id)).toMatchObject({ status: "failed", attempts: 6 });
  });
});

describe("owner login and dashboard", () => {
  const login = (password: string, ip = "1.1.1.1") =>
    call("/owner/login", { method: "POST", body: JSON.stringify({ username: "owner", password }), headers: { "CF-Connecting-IP": ip } });
  const sessionCookie = async () => (await login("correct horse")).headers.get("set-cookie")!.split(";")[0];

  it("keeps the dashboard and its data behind the login", async () => {
    const page = await call("/dashboard", { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await call("/owner/leads")).status).toBe(401);
    expect((await call("/owner/leads/1", { method: "PATCH", body: "{}" })).status).toBe(401);
  });

  it("rejects a wrong password and a forged cookie", async () => {
    expect((await login("wrong")).status).toBe(401);
    const forged = `${Date.now() + 1000000}.AAAA`;
    expect((await call("/owner/leads", { headers: { Cookie: `lead_inbox_session=${forged}` } })).status).toBe(401);
  });

  it("sets a locked-down cookie that opens the dashboard", async () => {
    const response = await login("correct horse");
    expect(response.status).toBe(200);
    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Strict/i);
    const page = await call("/dashboard", { headers: { Cookie: header.split(";")[0] } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("lists, filters and updates leads for a signed-in owner", async () => {
    const cookie = await sessionCookie();
    const lead = await create();
    await create({ message: "Do you work weekends?" });

    const data = (await (await call("/owner/leads?category=booking", { headers: { Cookie: cookie } })).json()) as {
      leads: (Lead & { sorted_by: string })[];
      counts: { status: Record<string, number>; category: Record<string, number> };
    };
    expect(data.leads.map((item) => item.id)).toEqual([lead.id]);
    expect(data.leads[0].sorted_by).toBe("rules");
    expect(data.counts.status).toEqual({ new: 1 });
    expect(data.counts.category).toEqual({ booking: 1, question: 1 });

    const updated = await call(`/owner/leads/${lead.id}`, { method: "PATCH", body: JSON.stringify({ status: "contacted", note: "Left a voicemail" }), headers: { Cookie: cookie } });
    expect(await updated.json()).toMatchObject({ status: "contacted", note: "Left a voicemail" });
  });

  it("blocks an address after 10 failed logins", async () => {
    for (let attempt = 0; attempt < 10; attempt++) expect((await login("wrong", "9.9.9.9")).status).toBe(401);
    expect((await login("correct horse", "9.9.9.9")).status).toBe(429);
    expect((await login("correct horse", "8.8.8.8")).status).toBe(200);
  });
});
