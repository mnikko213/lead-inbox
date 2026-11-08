import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  clearLoginFailures,
  createSession,
  isLoginBlocked,
  isValidBearer,
  isValidOwnerLogin,
  isValidSession,
  recordLoginFailure,
} from "./auth";
import { classify } from "./classify";
import { countFacets, getLead, getOwnerLead, insertLead, listLeads, listOwnerLeads, updateLead } from "./db";
import type { Env } from "./types";
import { MAX_BODY_BYTES, parseId, parseJsonObject, validateNewLead, validatePatch } from "./validate";
import { retryDueWebhooks, sendLeadCreated } from "./webhook";

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>({ strict: false });

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const normalizedPath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

const errorJson = (c: AppContext, status: 400 | 401 | 404 | 405 | 429 | 500, error: string) => c.json({ error }, status);

async function readBody(c: AppContext) {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return parseJsonObject("x".repeat(MAX_BODY_BYTES + 1));
  return parseJsonObject(await c.req.text());
}

const filtersFrom = (c: AppContext) => ({
  status: c.req.query("status") || undefined,
  category: c.req.query("category") || undefined,
});

app.onError((error, c) => {
  console.error(error);
  return c.req.path.startsWith("/api/") || c.req.path.startsWith("/owner/")
    ? errorJson(c, 500, "Something went wrong on the server. Try again.")
    : c.text("Something went wrong on the server. Try again.", 500);
});

/* ---------- Public API: paths, fields and status codes follow the brief ---------- */

app.use(
  "/api/*",
  cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"] }),
);

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const isPublicRoute = c.req.method === "POST" && normalizedPath(c.req.path) === "/api/leads";
  if (!isPublicRoute && !(await isValidBearer(c.env, c.req.header("authorization")))) {
    c.header("WWW-Authenticate", "Bearer");
    return errorJson(c, 401, "Missing or invalid token.");
  }
  await next();
});

app.post("/api/leads", async (c) => {
  const body = await readBody(c);
  if (!body.ok) return errorJson(c, 400, body.error);
  const input = validateNewLead(body.value);
  if (!input.ok) return errorJson(c, 400, input.error);

  const sorting = await classify(c.env, input.value);
  const lead = await insertLead(c.env.DB, input.value, sorting, Boolean(c.env.WEBHOOK_URL));
  // Sent before responding, so the event has landed by the time the caller hears 201.
  await sendLeadCreated(c.env, lead);
  return c.json(lead, 201);
});

app.get("/api/leads", async (c) => c.json({ leads: await listLeads(c.env.DB, filtersFrom(c)) }));

app.get("/api/leads/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const lead = id === null ? null : await getLead(c.env.DB, id);
  return lead ? c.json(lead) : errorJson(c, 404, "Lead not found.");
});

app.patch("/api/leads/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null || !(await getLead(c.env.DB, id))) return errorJson(c, 404, "Lead not found.");
  const body = await readBody(c);
  if (!body.ok) return errorJson(c, 400, body.error);
  const patch = validatePatch(body.value);
  if (!patch.ok) return errorJson(c, 400, patch.error);
  const lead = await updateLead(c.env.DB, id, patch.value);
  return lead ? c.json(lead) : errorJson(c, 404, "Lead not found.");
});

app.all("/api/leads", (c) => errorJson(c, 405, "Method not allowed."));
app.all("/api/leads/:id", (c) => errorJson(c, 405, "Method not allowed."));
app.all("/api/*", (c) => errorJson(c, 404, "Not found."));

/* ---------- Owner dashboard: cookie session, kept apart from the Bearer API ---------- */

app.post("/owner/login", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (await isLoginBlocked(c.env.DB, ip)) return errorJson(c, 429, "Too many failed attempts. Wait 15 minutes and try again.");

  const body = await readBody(c);
  if (!body.ok) return errorJson(c, 400, body.error);
  const { username, password } = body.value;
  if (typeof username !== "string" || typeof password !== "string" || !(await isValidOwnerLogin(c.env, username, password))) {
    await recordLoginFailure(c.env.DB, ip);
    return errorJson(c, 401, "Username or password is incorrect.");
  }

  await clearLoginFailures(c.env.DB, ip);
  setCookie(c, SESSION_COOKIE, await createSession(c.env), {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return c.json({ ok: true });
});

app.post("/owner/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

app.use("/owner/leads/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!(await isValidSession(c.env, getCookie(c, SESSION_COOKIE)))) return errorJson(c, 401, "Sign in to continue.");
  await next();
});

app.get("/owner/leads", async (c) => {
  const filters = filtersFrom(c);
  const [leads, counts] = await Promise.all([listOwnerLeads(c.env.DB, filters), countFacets(c.env.DB, filters)]);
  return c.json({ leads, counts });
});

app.patch("/owner/leads/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null || !(await getLead(c.env.DB, id))) return errorJson(c, 404, "Lead not found.");
  const body = await readBody(c);
  if (!body.ok) return errorJson(c, 400, body.error);
  const patch = validatePatch(body.value);
  if (!patch.ok) return errorJson(c, 400, patch.error);
  await updateLead(c.env.DB, id, patch.value);
  return c.json(await getOwnerLead(c.env.DB, id));
});

app.all("/owner/*", (c) => errorJson(c, 404, "Not found."));

/* ---------- Pages ---------- */

app.get("/dashboard", async (c, next) => {
  if (!(await isValidSession(c.env, getCookie(c, SESSION_COOKIE)))) return c.redirect("/login", 302);
  await next();
});

app.get("/login", async (c, next) => {
  if (await isValidSession(c.env, getCookie(c, SESSION_COOKIE))) return c.redirect("/dashboard", 302);
  await next();
});

app.all("*", async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  const response = new Response(asset.body, asset);
  response.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  if (["/dashboard", "/login"].includes(normalizedPath(c.req.path))) response.headers.set("Cache-Control", "no-store");
  return response;
});

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(retryDueWebhooks(env));
  },
} satisfies ExportedHandler<Env>;
