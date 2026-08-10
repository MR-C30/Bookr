# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
## Blueprint
See [blueprint.md](blueprint.md) for the full tech stack, file structure, and
integration specs. Current phase scope: one tenant, one staff member, one
service, real Google
Calendar OAuth, real Payfast sandbox checkout, real webhook writing to
appointments. Do not build upsells, multi-tenant theming, or WhatsApp/SMS yet.

## Project state

**Bookr** is a multi-tenant SaaS booking platform for barbershops and
massage parlors in South Africa. The Next.js App Router project is scaffolded
(TypeScript, Tailwind CSS v4, Shadcn UI) and `lib/supabase.ts` +
`lib/google-calendar.ts` are implemented. Per [blueprint.md](blueprint.md),
the stack is fixed and non-negotiable — do not substitute an alternative
framework/library even if it seems simpler:

- **Framework:** Next.js, App Router, TypeScript
- **Styling:** Tailwind CSS, Shadcn UI components
- **Database & Auth:** Supabase (Postgres, RLS, Auth) — see [schema.sql](schema.sql)
- **Calendar:** Google Calendar API (OAuth 2.0), two-way sync
- **Payments:** Payfast or Yoco, deposit-based checkout in ZAR
- **Notifications:** Twilio WhatsApp / BulkSMS — out of scope for now, don't build yet

**Design philosophy:** mobile-first, beginner-accessible code with clear
inline comments — the person maintaining this repo has under a year of
coding experience, so favor explicit, readable code over clever abstraction.

The booking funnel this app must support end to end:
`Landing Page -> Service & Upsell Selection -> Slot Picker (Google Cal API) -> SA Payment Checkout -> Auto-Calendar Sync & Confirmation`
— though per phase scope above, only build the single-tenant/single-staff/
single-service path for now.

### Expected file structure

```
app/
  book/[slug]/page.tsx        -- public booking page for a tenant, reads slug from schema.tenants
  api/
    auth/callback/google/route.ts   -- OAuth redirect target, calls exchangeCodeForTokens()
    checkout/route.ts               -- generates Payfast/Yoco checkout payload + signature
    webhooks/payfast/route.ts       -- verifies ITN, updates appointments, calls createEvent()
lib/
  google-calendar.ts   -- getAvailableSlots(), createEvent(), auth helpers
  supabase.ts          -- service-role Supabase client (server-only)
  payfast.ts           -- signature generation, ZAR amount handling
components/ui/         -- Shadcn components
```

Key integration contracts (specs to implement against schema.sql):
- `lib/google-calendar.ts` resolves `tenant_id`/`timezone` via `calendarId`,
  stores refresh tokens on `tenants.google_refresh_token`, uses the
  service-role Supabase client.
- `app/api/checkout/route.ts` reads `deposit_type`/`deposit_value` from the
  tenant row, creates a `pending_payment` appointment, returns the checkout
  redirect URL.
- `app/api/webhooks/payfast/route.ts` must verify the Payfast signature
  before trusting the payload — never trust an unverified webhook. On
  verified success: set `appointments.status = 'confirmed'`, insert a
  `payments` row, call `createEvent()`, store the returned
  `google_calendar_event_id`.

### Environment variables required so far

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback/google
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
PAYFAST_MERCHANT_ID=
PAYFAST_MERCHANT_KEY=
PAYFAST_PASSPHRASE=
PAYFAST_URL=https://sandbox.payfast.co.za/eng/process
```

`PAYFAST_MODE` also exists in `.env.local` but is currently unused — see
Known issues below.

### Commands

```
npm run dev     -- start the dev server (http://localhost:3000)
npm run build   -- production build
npm run lint    -- ESLint
npx tsc --noEmit -- typecheck (no separate test suite yet)
```

There is no test suite yet.

## Known issues

- **`npm audit`: 3 high-severity advisories, deferred.** Both are nested
  inside `next@16.2.12`'s own dependency tree (not top-level deps we chose),
  and `next@16.2.12` is currently the latest release:
  - `postcss@8.4.31` (bundled inside `node_modules/next`, distinct from the
    non-vulnerable `postcss@8.5.25` Tailwind uses at the top level): XSS via
    unescaped `</style>` in CSS stringify output, plus arbitrary `.map` file
    read via attacker-controlled `sourceMappingURL` in CSS comments. Low
    relevance today — we only run postcss over our own build-time CSS, never
    untrusted input.
  - `sharp@0.34.5` (an `optionalDependency` of `next`, powers `next/image`'s
    optimizer): inherited `libvips` CVEs (2026-33327/33328/35590/35591),
    malformed-image parsing bugs. **Must be re-evaluated before building any
    feature that renders tenant-supplied images via `next/image`** —
    `tenants.logo_url`, `staff.photo_url`, and `services.image_url` are all
    attacker-influenceable inputs once those UI pieces exist.
  - `npm audit fix --force`'s suggested fix (downgrade `next` to `9.3.3`, pre-
    App Router) is not a real fix — don't run it. `next` pins
    `sharp: "^0.34.5"`, which for a `0.x` package only allows patch bumps, so
    it can't resolve to a patched `sharp@0.35.x+` without either an `npm`
    `overrides` entry or an upstream pin bump from Next.js. Re-check
    `npm audit` when upgrading `next`.

- **`PAYFAST_MODE` env var is currently unused.** `.env.local` defines it,
  but `lib/payfast.ts` reads `PAYFAST_URL` directly and hardcodes nothing
  else — there's no sandbox/live branching logic. Before going live, this
  needs a real switch (e.g. `lib/payfast.ts` picking between two known URLs
  based on `PAYFAST_MODE`, with validation that they can't drift out of
  sync) so a misconfigured environment can't accidentally hit the wrong
  Payfast endpoint.

## Database schema

[schema.sql](schema.sql) is meant to be pasted directly into the Supabase
SQL Editor and run as-is (target: Supabase / PostgreSQL 15+). Key design
points to keep in mind when extending it:

- **Multi-tenancy**: `public.tenants` is the white-label unit (one row per
  parlor/barbershop). Every other business table (`staff`, `services`,
  `customers`, `appointments`, `payments`) carries a `tenant_id` and is scoped
  to it. `staff_services` is a plain join table with no `tenant_id` of its own
  — tenant scoping is derived via the `staff` row. Each tenant also carries its own `timezone` (default `'Africa/Johannesburg'`) and `currency` (default `'ZAR'`) — use `tenants.timezone` as the source of truth for any date/time or slot-availability logic, not a hardcoded timezone.
- **Auth model**: `tenants.owner_id` references `auth.users` (the Supabase
  auth user who administers the parlor). `staff.user_id` is an *optional*
  login for individual staff. End customers booking appointments do **not**
  have Supabase auth accounts — the public booking flow is unauthenticated
  and identifies customers by phone number (`unique (tenant_id, phone)`).
- **Row Level Security is load-bearing, not incidental**: every table has RLS
  enabled, gated through the `public.is_tenant_owner(tenant_id)` helper
  function (`security definer`, checks `auth.uid() = tenants.owner_id`).
  Public/anonymous writes for the booking flow (creating `customers` and
  `appointments`) are intentionally **not** covered by RLS insert policies —
  they're expected to go through server-side API routes using the Supabase
  *service role* key, which bypasses RLS. Any new client-writable table
  should follow this same split: RLS policies for the authenticated
  tenant-owner dashboard, service-role bypass for the untrusted public flow.
- **Double-booking prevention**: `appointments` uses a Postgres exclusion
  constraint (`no_overlapping_appointments`, requires `btree_gist`) rather
  than application-level locking — it excludes overlapping `tsrange(start_time,
  end_time)` per `staff_id`, but only while `status in
  ('pending_payment','confirmed')`, so cancelled/completed appointments don't
  block rebooking that slot.
- **Payments** are decoupled from appointments as their own table
  (`public.payments`), one row per payment *attempt* (not per appointment),
  supporting `payfast` and `yoco` as providers. `raw_webhook_payload` stores
  the full ITN/webhook body for audit. Payment rows are written only by
  webhook handlers via the service role key — there's no client insert path.
- **`updated_at` triggers** are applied generically via a `do $$ ... $$`
  block that loops over table names and creates a `trg_set_updated_at`
  trigger calling `public.set_updated_at()` on each — if you add a new table
  with an `updated_at` column, add its name to that loop rather than
  hand-writing a new trigger.
- Secrets embedded in `tenants` (`google_refresh_token`, `yoco_secret_key`,
  `payfast_merchant_key`) are plaintext columns with a comment noting they
  should be encrypted at rest (Supabase Vault / pgsodium) in production —
  don't take the current column type as a sign plaintext storage is fine to
  build on top of.
- Re-running the script is (mostly) idempotent: tables/indexes use
  `if not exists` and the trigger loop drops-then-recreates, but the
  `no_overlapping_appointments` exclusion constraint is added via a plain
  `alter table ... add constraint` with no `if not exists` guard, so re-running
  the whole file against a database that already has it will error.
