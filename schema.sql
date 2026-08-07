-- BOOKING PLATFORM — CORE DATABASE SCHEMA
-- Target: Supabase (PostgreSQL 15+)
-- Multi-tenant SaaS for barbershops / massage parlors in South Africa
--
-- HOW TO RUN THIS:
--   1. Open your Supabase project -> SQL Editor -> New Query
--   2. Paste this entire file
--   3. Click "Run"
--   This creates all tables, indexes, and Row Level Security (RLS) policies.
-- ============================================================================
 
-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";
 
-- ============================================================================
-- 1. TENANTS (the parlor/barbershop itself — this is the "white-label" unit)
-- ============================================================================
create table if not exists public.tenants (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  business_name     text not null,
  slug              text not null unique,             -- used in booking URL: /book/[slug]
  business_type     text not null check (business_type in ('barbershop', 'massage_parlor', 'other')),
  timezone          text not null default 'Africa/Johannesburg',
  currency          text not null default 'ZAR',
  logo_url          text,
  brand_color       text default '#111111',           -- for white-label theming
  contact_phone     text,                              -- used for WhatsApp/SMS sender identity
  contact_email     text,
  google_calendar_id      text,                        -- calendar ID connected via OAuth
  google_refresh_token    text,                        -- encrypted at rest (see note below)
  payfast_merchant_id     text,
  payfast_merchant_key    text,
  yoco_secret_key         text,                        -- store encrypted, never expose to client
  deposit_type      text not null default 'fixed' check (deposit_type in ('fixed', 'percentage')),
  deposit_value     numeric(10,2) not null default 100.00, -- R100 fixed, or e.g. 20 = 20%
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
 
comment on table public.tenants is 'One row per parlor/barbershop. All other business data is scoped to a tenant_id.';
comment on column public.tenants.google_refresh_token is 'Store via Supabase Vault or pgsodium encryption in production — never store plaintext OAuth tokens.';
 
-- ============================================================================
-- 2. STAFF (service providers within a tenant)
-- ============================================================================
create table if not exists public.staff (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null, -- optional: staff can have login
  full_name         text not null,
  photo_url         text,
  bio               text,
  google_calendar_id      text,          -- individual staff calendar (optional override of tenant's)
  working_hours     jsonb not null default '{
    "mon": [["09:00","18:00"]],
    "tue": [["09:00","18:00"]],
    "wed": [["09:00","18:00"]],
    "thu": [["09:00","18:00"]],
    "fri": [["09:00","18:00"]],
    "sat": [["09:00","14:00"]],
    "sun": []
  }'::jsonb,      -- array of [start,end] ranges per day, allows split shifts
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
 
comment on table public.staff is 'Individual service providers (barbers/therapists) belonging to a tenant.';
 
-- ============================================================================
-- 3. SERVICES (bookable services + add-ons/upsells, scoped to a tenant)
-- ============================================================================
create table if not exists public.services (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  name              text not null,
  description       text,
  duration_minutes  int not null check (duration_minutes > 0),
  price             numeric(10,2) not null check (price >= 0),
  is_addon          boolean not null default false,   -- true = shown as an upsell, not a primary service
  parent_service_id uuid references public.services(id) on delete set null, -- addon belongs to which primary service
  image_url         text,
  sort_order        int not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
 
comment on table public.services is 'Primary services and add-on/upsell services. is_addon=true rows are offered in the upsell step.';
 
-- Join table: which staff members can perform which services
create table if not exists public.staff_services (
  staff_id    uuid not null references public.staff(id) on delete cascade,
  service_id  uuid not null references public.services(id) on delete cascade,
  primary key (staff_id, service_id)
);
 
-- ============================================================================
-- 4. CUSTOMERS (end clients booking appointments — shared across tenants
--    by phone number, but bookings themselves are tenant-scoped)
-- ============================================================================
create table if not exists public.customers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  full_name         text not null,
  phone             text not null,        -- E.164 format e.g. +27821234567, used for WhatsApp/SMS
  email             text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, phone)
);
 
comment on table public.customers is 'Customers are scoped per-tenant so each parlor manages its own client list.';
 
-- ============================================================================
-- 5. APPOINTMENTS (the core booking record)
-- ============================================================================
create table if not exists public.appointments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete cascade,
  staff_id              uuid not null references public.staff(id) on delete restrict,
  primary_service_id    uuid not null references public.services(id) on delete restrict,
  addon_service_ids      uuid[] not null default '{}',  -- array of add-on service IDs selected
  start_time            timestamptz not null,
  end_time              timestamptz not null,
  status                text not null default 'pending_payment'
                          check (status in ('pending_payment','confirmed','cancelled','completed','no_show')),
  total_price           numeric(10,2) not null,          -- full price of service + addons
  deposit_amount        numeric(10,2) not null,          -- amount required upfront
  google_calendar_event_id  text,                        -- set once synced to Google Calendar
  reminder_sent_at       timestamptz,
  cancellation_reason    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
 
  constraint valid_time_range check (end_time > start_time)
);
 
comment on table public.appointments is 'Core booking record. status starts pending_payment until webhook confirms deposit paid.';
 
-- Prevent double-booking the same staff member for overlapping time ranges
-- (requires btree_gist extension for the exclusion constraint)
create extension if not exists btree_gist;
 
alter table public.appointments
  add constraint no_overlapping_appointments
  exclude using gist (
    staff_id with =,
    tstzrange(start_time, end_time) with &&
  )
  where (status in ('pending_payment', 'confirmed'));
 
create index if not exists idx_appointments_tenant_starttime on public.appointments (tenant_id, start_time);
create index if not exists idx_appointments_staff_starttime on public.appointments (staff_id, start_time);
 
-- ============================================================================
-- 6. PAYMENTS (deposit / transaction records, one per appointment attempt)
-- ============================================================================
create table if not exists public.payments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  appointment_id        uuid not null references public.appointments(id) on delete cascade,
  provider              text not null check (provider in ('payfast', 'yoco')),
  provider_reference    text,             -- pf_payment_id / yoco checkout id
  amount                numeric(10,2) not null,
  currency              text not null default 'ZAR',
  status                text not null default 'initiated'
                          check (status in ('initiated','pending','complete','failed','cancelled')),
  raw_webhook_payload    jsonb,            -- store full ITN/webhook body for audit/debugging
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
 
comment on table public.payments is 'One row per payment attempt. raw_webhook_payload stores the full ITN body for audit trail.';
 
create index if not exists idx_payments_appointment on public.payments (appointment_id);
create index if not exists idx_payments_provider_ref on public.payments (provider_reference);
 
-- ============================================================================
-- updated_at auto-update trigger (applies to all tables with updated_at)
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
 
do $$
declare t text;
begin
  for t in select unnest(array['tenants','staff','services','customers','appointments','payments'])
  loop
    execute format('
      drop trigger if exists trg_set_updated_at on public.%I;
      create trigger trg_set_updated_at
        before update on public.%I
        for each row execute function public.set_updated_at();
    ', t, t);
  end loop;
end $$;
 
-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
--
-- Model:
--   - tenants.owner_id  -> the Supabase auth user who owns/admins the parlor
--   - staff.user_id     -> optional login for individual staff members
--   - Public/anonymous users can INSERT customers + appointments (the public
--     booking flow), but can only SELECT their own data via a secure token
--     (handled at the API layer, not via RLS, since booking customers don't
--     have Supabase auth accounts).
--   - Tenant owners can do everything within their own tenant.
-- ============================================================================
 
alter table public.tenants enable row level security;
alter table public.staff enable row level security;
alter table public.services enable row level security;
alter table public.staff_services enable row level security;
alter table public.customers enable row level security;
alter table public.appointments enable row level security;
alter table public.payments enable row level security;
 
-- Helper: is the current auth user the owner of this tenant?
create or replace function public.is_tenant_owner(check_tenant_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.tenants
    where id = check_tenant_id
    and owner_id = auth.uid()
  );
$$ language sql security definer stable;
 
-- ---- TENANTS ----
create policy "Owners can view their own tenant"
  on public.tenants for select
  using (owner_id = auth.uid());
 
create policy "Owners can update their own tenant"
  on public.tenants for update
  using (owner_id = auth.uid());
 
create policy "Authenticated users can create a tenant"
  on public.tenants for insert
  with check (owner_id = auth.uid());
 
-- Public read access to minimal tenant branding info for the booking page
-- (slug, business_name, logo, brand_color) is handled via a separate public
-- VIEW in step 2, not by opening this table directly to anon.
 
-- ---- STAFF ----
create policy "Tenant owners manage their staff"
  on public.staff for all
  using (public.is_tenant_owner(tenant_id))
  with check (public.is_tenant_owner(tenant_id));
 
create policy "Anyone can view active staff (for public booking flow)"
  on public.staff for select
  using (is_active = true);
 
-- ---- SERVICES ----
create policy "Tenant owners manage their services"
  on public.services for all
  using (public.is_tenant_owner(tenant_id))
  with check (public.is_tenant_owner(tenant_id));
 
create policy "Anyone can view active services (for public booking flow)"
  on public.services for select
  using (is_active = true);
 
-- ---- STAFF_SERVICES ----
create policy "Tenant owners manage staff-service mappings"
  on public.staff_services for all
  using (
    exists (
      select 1 from public.staff s
      where s.id = staff_id and public.is_tenant_owner(s.tenant_id)
    )
  );
 
create policy "Anyone can view staff-service mappings"
  on public.staff_services for select
  using (true);
 
-- ---- CUSTOMERS ----
create policy "Tenant owners manage their customers"
  on public.customers for all
  using (public.is_tenant_owner(tenant_id))
  with check (public.is_tenant_owner(tenant_id));
 
-- Public booking flow inserts a customer row via the server (service role),
-- not directly from the browser — so no public insert policy is defined here.
-- This keeps customer PII writes funneled through your API routes only.
 
-- ---- APPOINTMENTS ----
create policy "Tenant owners manage their appointments"
  on public.appointments for all
  using (public.is_tenant_owner(tenant_id))
  with check (public.is_tenant_owner(tenant_id));
 
-- Same pattern: public booking writes go through server-side API routes
-- using the Supabase service role key, which bypasses RLS safely because
-- validation happens in your trusted backend code, not the browser.
 
-- ---- PAYMENTS ----
create policy "Tenant owners view their payments"
  on public.payments for select
  using (public.is_tenant_owner(tenant_id));
 
-- Payments are only ever written by your webhook handlers using the
-- service role key — never expose payment writes to any client role.
 
-- ============================================================================
-- END OF STEP 1
-- Next: Step 2 — Next.js App Router project file structure