# Bookr — Progress Report & Roadmap

**Goal:** One working demo — one tenant, one staff member, one service, real Google Calendar OAuth, real Payfast sandbox checkout, real webhook writing to `appointments`.

---

## Status: 4 of 5 features built, 1 unverified

```
[✅ DONE]        1. Google Calendar OAuth
[✅ DONE]        2. Public booking page (slot picker)
[✅ DONE]        3. Payfast integration (signature/payload code written)
[⚠️ UNVERIFIED]  4. Checkout route (redirects to Payfast, but the sandbox
                    round-trip has not actually been confirmed — see below)
[⬜ NEXT]        5. Webhook (finish line)
```

---

## What's actually built and verified

**Environment**
- Claude Code + Cursor working together, install issues fixed
- Google Cloud project, Calendar API enabled, OAuth client configured
- Supabase project, service-role key configured
- `.env.local` fully populated and gitignored correctly

**Codebase**
- Full Next.js App Router scaffold (TypeScript, Tailwind, Shadcn UI)
- `lib/supabase.ts` — service-role database client
- `lib/google-calendar.ts` — `getAvailableSlots`, `createEvent`, `getAuthUrl`, `exchangeCodeForTokens`
- `app/api/auth/callback/google/route.ts` — OAuth callback, tested live
- `schema.sql`, `blueprint.md`, `CLAUDE.md` all in repo, referencing each other correctly

**Database**
- Schema deployed to Supabase (fixed a real bug: `tsrange` → `tstzrange`)
- One tenant seeded: Classic Cuts (`6412ecd0-e971-41b8-a160-9f274a3235df`)
- One staff member seeded: Thabo Nkosi, linked to your real Gmail calendar
- One service seeded: Classic Haircut, 30 min, R150
- Staff-service link confirmed via join query

**Feature 1 — proven working, not just built**
- Real Google consent screen completed
- Real refresh token landed in `tenants.google_refresh_token`
- Full chain verified: `getAuthUrl` → Google consent → callback → token exchange → DB write

---

## Known issues, logged (not blocking, don't forget them)

- **Payfast checkout has not actually been confirmed against the sandbox.**
  `app/api/checkout/route.ts` has a `TEMPORARY` comment (as of commit
  `537d573`) stating `lib/payfast.ts`'s signature logic "hasn't been
  verified against a real Payfast sandbox transaction yet," and only
  `console.log`s the checkout URL rather than confirming a real redirect
  succeeded. That commit's message ("tested end to end") overstates this —
  don't trust it. Treat step 4 as done only once a real browser run
  reaches the Payfast sandbox payment page with the correct R-amount
  without a signature-mismatch error, then remove the TEMPORARY comment.
- **A stray file was accidentally committed in `537d573`** — a 327-line
  capture of `less --help` output, with a garbled filename derived from
  the commit message. Removed in a follow-up commit. Worth double-checking
  `git status`/`git add <specific files>` (not `git add .`) before
  committing to avoid picking up terminal artifacts like this again.
- **npm audit**: 3 high-severity advisories (sharp/libvips, nested postcss) — deferred, documented in `CLAUDE.md`. Must revisit before building any feature that renders tenant-uploaded images (`logo_url`, `photo_url`, `image_url`).
- **Google app is in "Testing" mode** — capped at 100 test users, refresh tokens may expire after 7 days. Fine for demo phase. Will need Google's app verification process before onboarding real host #1 as a live customer — that process takes time, worth starting early once the demo is solid.
- **Slow filesystem warning** from Next.js/Turbopack — not yet root-caused. Not blocking, but if dev server slowness returns, worth investigating (could be antivirus scanning, could be something else).
- **Payfast ITN signature mismatch — investigation notes (2026-08-17), not yet resolved.** A real ITN reaches `app/api/webhooks/payfast/route.ts` and parses correctly, but `generateSignature()`'s output doesn't match Payfast's `signature` field. Checked so far, all clean — none of these explain the mismatch:
  - `generateSignature()` (`lib/payfast.ts:73-86`) correctly excludes the `signature` key itself before hashing (line 78).
  - Checkout-side (`buildCheckoutUrl`) field order: verified against Payfast's **official** PHP SDK (`github.com/PayFast/payfast-php-sdk`, `lib/Auth.php`). Its `generateSignature()` only filters fields against an allowlist (`array_filter(..., ARRAY_FILTER_USE_KEY)`) — PHP preserves the input array's original order, it does *not* re-sort to a canonical sequence. So there's no Payfast-mandated field order to match; only internal consistency (same order for the hash and the submitted query string) matters, and `buildCheckoutUrl` already does that. The old comment in `lib/payfast.ts:65-72` claiming this was based on unverified "third-party write-ups" can be updated to cite this SDK instead.
  - ITN-side field order: `app/api/webhooks/payfast/route.ts` builds `fields` by walking `formData.entries()` in received order, and `generateSignature()` never re-sorts — so it signs in the order Payfast sent, which is what Payfast's docs require for ITN verification.
  - `payfastEncode()` (`lib/payfast.ts:59-63`): reviewed against PHP's `urlencode()` character-class rules (space → `+`; `! ' ( ) * ~` percent-escaped, which `encodeURIComponent` alone leaves untouched). The logic matches byte-for-byte for every character class checked.
  - Blank-field handling: `String(value) !== ""` correctly drops empty fields while keeping `"0"` values, matching Payfast's documented quirk.
  - `PUBLIC_BASE_URL` (currently `https://fragile-purr-repair.ngrok-free.dev`, no trailing slash) produces a clean `notify_url` with no double slash. Note for later: there's no code-level guard against someone adding a trailing slash to this env var in future — worth normalizing/validating eventually. Also worth remembering: `notify_url`/`return_url`/`cancel_url` are **not** fields Payfast echoes back in the ITN payload itself, so even a malformed `notify_url` would surface as an ITN that never arrives, not a signature mismatch on one that did.
  - **Not yet done:** a temporary `console.log` was added in `generateSignature()` (`lib/payfast.ts`, right before the `md5` hash call) to print the exact raw pre-hash string via `JSON.stringify`. Haven't yet captured real output from it — the local dev server and the ngrok tunnel were both down when this was attempted, and triggering a fresh sandbox checkout + real ITN round-trip wasn't finished tonight. **This is the most direct next step**: get the dev server + ngrok tunnel up, run a real sandbox checkout to completion, capture the logged raw string, and diff it byte-for-byte against a manually-recomputed signature over the same ITN payload. Remember to remove that `console.log` afterward — it prints `PAYFAST_PASSPHRASE` in cleartext to logs.
  - Other unverified suspects worth checking if the raw-string diff doesn't explain it: whether ngrok is altering the request body/headers in transit, whether Payfast sandbox POSTs as multipart instead of `application/x-www-form-urlencoded` (which `request.formData()` would parse differently), and whether `.env.local`'s `PAYFAST_PASSPHRASE` has any hidden leading/trailing whitespace.

---

## Next steps — in order, don't skip ahead

### Step 1 — Trigger button for OAuth (small, quick)
Right now `getAuthUrl()` only gets called via a manual test script. Before building the real booking page, add a simple "Connect Google Calendar" link/button on a basic admin page that calls `getAuthUrl(tenantId)` for real — this is what a real tenant owner would click during onboarding.

### Step 2 — Feature 2: Public booking page
**File:** `app/book/[slug]/page.tsx`
- Reads the tenant by `slug` ("classic-cuts")
- Shows the one seeded service
- Calls `getAvailableSlots` using the staff member's `google_calendar_id` and the service's `duration_minutes`
- Renders real open times as clickable slots

✅ Done when: visiting the booking URL shows real available times pulled from your actual calendar.

### Step 3 — Feature 3: Payfast integration
**Before coding:** sign up for a Payfast sandbox account (external step, do this first — approval/setup can take time, don't let it block coding time).
**File:** `lib/payfast.ts` — signature generation, ZAR checkout payload.

✅ Done when: a test script can generate a valid signed sandbox payload.

### Step 4 — Feature 4: Checkout route
**File:** `app/api/checkout/route.ts`
- Selecting a slot creates a `pending_payment` row in `appointments`
- Builds the Payfast redirect using `lib/payfast.ts`
- Code is written, but the redirect itself is unverified — see Known issues.

⬜ Done when: clicking a slot on the booking page redirects to a real Payfast sandbox payment page with the correct amount, with no signature-mismatch error.

### Step 5 — Feature 5: Webhook (the finish line)
**File:** `app/api/webhooks/payfast/route.ts`
- Verifies the ITN signature (never trust an unverified webhook)
- Updates `appointments.status` to `confirmed`
- Writes a `payments` row
- Calls `createEvent` to write the appointment to Google Calendar
- Stores the returned `google_calendar_event_id`

✅ Done when: paying in sandbox → appointment shows `confirmed` in Supabase → event appears on your real Google Calendar automatically. **This is the actual pitch-ready demo moment.**

---

## Working discipline to keep (it's working — don't drop it)

1. Read every plan before approving
2. Approve one command at a time — don't blanket-approve
3. Check the actual diff/file content, not just the "create file?" prompt
4. Verify claims against the real database/files — don't trust memory or scrollback
5. When something looks off, stop and ask before proceeding