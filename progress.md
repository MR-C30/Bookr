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