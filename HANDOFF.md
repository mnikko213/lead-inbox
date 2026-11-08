# Lead inbox handoff

Live app: https://lead-inbox.mnikko213.workers.dev

| What | Where |
| --- | --- |
| Customer form | https://lead-inbox.mnikko213.workers.dev/ |
| Owner dashboard | https://lead-inbox.mnikko213.workers.dev/dashboard |
| API base | https://lead-inbox.mnikko213.workers.dev/api/leads |

## Logins

- Owner login: username `owner`, password `sb2gfxth8xx9mh3krg`
- API_TOKEN: `7b015eb1c36d5a200689021038adb7bd3186e15d7767937d`

These are test credentials, written here because the brief asks for them. Change them after grading, because this repo is public.

## How to run it

It's a single Cloudflare Worker with a D1 (SQLite) database. You need Node 20 or newer.

```
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Then open http://localhost:8787. Local runs use the keyword rules for sorting, so no Cloudflare account is needed.

Run the tests with `npm test`.

To deploy your own copy: run `npx wrangler d1 create lead-inbox`, put the new id in `wrangler.jsonc`, run `npm run db:migrate:remote`, run `npm run deploy`, then set API_TOKEN, OWNER_PASSWORD, SESSION_SECRET and WEBHOOK_URL with `npx wrangler secret put`.

## What works

- Public form with every rule checked on the server. Bad input gets a clear 400, never a crash.
- Leads saved in a real database. They survive refreshes, restarts and redeploys.
- Every lead is sorted by a Cloudflare AI model. If the AI fails, times out, runs out of quota or answers with something invalid, keyword rules decide instead. The rules also know some Tagalog.
- Owner dashboard behind a login, built for phones: newest first, filter by status and category, change status, add notes. New leads appear within 20 seconds.
- All API routes as written in the brief. Text comes back exactly as typed, and markup in a lead shows as plain text on the dashboard.
- Webhook on every saved lead. If the URL is down the lead still saves, and the send is retried up to 5 more times over about 8 hours.
- 112 automated tests, plus a full test against the live URL.

## What doesn't work yet

- No spam protection or rate limit on the public form. I left this out on purpose so a test script posting many leads isn't blocked.
- One owner account only.
- The owner gets no email or SMS for a new lead. They need to open the dashboard.
- The webhook isn't signed, so a receiver can't prove it came from this app.
- Lists stop at the newest 200 leads. There is no paging yet.

The database has 3 sample leads from my final live test, and those also went to the webhook.

## What I assumed where the brief was unclear

- **Service is required.** The brief marks only phone as optional.
- **Blank text counts as missing.** A name of only spaces gets a 400. Valid text is stored untouched, including outer spaces.
- **An email with spaces around it is invalid,** rather than being silently trimmed.
- **Phone is free text up to 50 characters,** because formats vary too much to validate.
- **Length limits count characters as people do,** so one emoji is one character.
- **Text that can't be stored unchanged gets a 400:** NUL characters and broken Unicode.
- **Notes can be up to 5000 characters.** The brief sets no limit.
- **A filter value that matches nothing returns 200 with an empty list,** not an error.
- **PATCH with neither status nor note returns 400.** Other fields are ignored, and a bad status means nothing in that request is saved.
- **Ids that aren't plain positive numbers return 404,** such as `abc` or `1.5`.
- **The token is checked first,** so a bad token on a missing lead returns 401, not 404.
- **The dashboard signs in with a cookie on its own `/owner` routes.** `/api` accepts only the Bearer token, exactly as briefed.
- **The webhook is sent before the 201 is returned,** with a 3 second limit, so the event has normally landed when the caller gets its response.
- **Complaints are always high urgency,** because an unhappy customer should get the first callback.
- **CORS is open on `/api`,** so other teams and business websites can call it.

## What I'd do next

1. Add spam protection to the form (Cloudflare Turnstile plus a per-address limit).
2. Email or SMS the owner on high-urgency leads.
3. Sign webhooks so receivers can verify them.
4. Add paging and search.
5. Support several businesses and staff logins, since this is one piece of a larger CRM.
