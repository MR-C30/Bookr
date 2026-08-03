# Bookr — Architecture Blueprint (Reference)

This is the working spec for Bookr's tech stack and structure. Written to be
read by Claude Code alongside `schema.sql`. This is a summary of the
original architecture document, not the full text.

## Tech stack (required, not optional)

- **Framework:** Next.js, App Router, TypeScript
- **Styling:** Tailwind CSS, Shadcn UI components
- **Database & Auth:** Supabase (PostgreSQL, Row Level Security, Auth) — see `schema.sql`
- **Calendar:** Google Calendar API (OAuth 2.0), two-way sync
- **Payments:** Payfast or Yoco (South African gateways), deposit-based checkout in ZAR
- **Notifications:** Twilio WhatsApp API / BulkSMS (not part of the current build phase)

## Design philosophy

Mobile-first. Clean, scalable, beginner-accessible code with clear inline
comments — the person maintaining this repo has under a year of coding
experience, so favor explicit, readable code over clever abstraction.

## The booking funnel (what the app needs to support end to end)

```
Landing Page -> Service & Upsell Selection -> Slot Picker (Google Cal API)
-> SA Payment Checkout -> Auto-Calendar Sync & Confirmation
```

Current build phase covers only: one tenant, one staff member, one service,
real Google Calendar OAuth, real Payfast sandbox checkout, and a real
webhook confirming payment and writing to `appointments`. Upsells,
multi-tenant theming, and WhatsApp/SMS reminders are explicitly **out of
scope** for this phase — don't build them yet even if convenient to add.

## Expected file structure (Next.js App Router)

```
app/
  book/
    [slug]/
      page.tsx              -- public booking page for a tenant, reads slug from schema.tenants
  api/
    auth/
      callback/
        google/
          route.ts           -- OAuth redirect target, calls exchangeCodeForTokens()
    checkout/
      route.ts                -- generates Payfast/Yoco checkout payload + signature
    webhooks/
      payfast/
        route.ts               -- verifies ITN, updates appointments, calls createEvent()
lib/
  google-calendar.ts          -- getAvailableSlots(), createEvent(), auth helpers
  supabase.ts                 -- service-role Supabase client (server-only)
  payfast.ts                  -- signature generation, ZAR amount handling
components/
  ui/                         -- Shadcn components
schema.sql
CLAUDE.md
blueprint.md
.env.local
```

## Core integration snippets (specs, to be implemented against schema.sql)

### `lib/google-calendar.ts`
Functions to list available slots and insert new events into Google
Calendar. (Already scoped in detail across this conversation — resolves
`tenant_id`/`timezone` via `calendarId`, stores refresh tokens on
`tenants.google_refresh_token`, uses service-role Supabase client.)

### `app/api/checkout/route.ts`
API route generating the Payfast/Yoco secure signature and checkout payload
for a booking deposit, in ZAR. Reads `deposit_type`/`deposit_value` from the
relevant `tenants` row per `schema.sql`. On call: creates a `pending_payment`
row in `appointments`, returns the checkout redirect URL.

### `app/api/webhooks/payfast/route.ts`
Secure ITN/webhook listener. Must verify the Payfast signature before
trusting the payload (never trust an unverified webhook). On verified
success: update `appointments.status` to `confirmed`, write a row to
`payments`, call `createEvent()` to write the appointment to Google
Calendar, store the returned `google_calendar_event_id`.

## Environment variables required so far

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback/google
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Payfast sandbox credentials (`payfast_merchant_id`, `payfast_merchant_key`)
will be needed once the checkout route is built — not required yet for
`lib/google-calendar.ts`.