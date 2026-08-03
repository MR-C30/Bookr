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
