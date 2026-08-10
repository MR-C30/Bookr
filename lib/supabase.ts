import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client using the service role key.
// This key bypasses Row Level Security, so it must never be imported
// into any client component or exposed to the browser.
if (!process.env.SUPABASE_URL) {
  throw new Error("Missing required env var: SUPABASE_URL");
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env var: SUPABASE_SERVICE_ROLE_KEY");
}
if (!process.env.SUPABASE_ANON_KEY) {
  throw new Error("Missing required env var: SUPABASE_ANON_KEY");
}

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// Anon-key client that respects Row Level Security. Use this for reads that
// are already covered by a public RLS policy (e.g. active staff/services on
// the public booking page) instead of reaching for supabaseAdmin, which
// bypasses RLS entirely and should be reserved for tables/actions that have
// no public policy (e.g. tenants).
export const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
