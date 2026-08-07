// Throwaway manual-testing script — NOT part of the app, safe to delete.
//
// Prints the Google Calendar consent URL for a given tenant_id so you can
// paste it into a browser and walk through the OAuth flow by hand.
//
// Usage:
//   npx tsx scripts/get-auth-url.ts <tenant_id>
//
// Loads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY from .env.local, since lib/google-calendar.ts
// also imports lib/supabase.ts at load time and needs the Supabase vars too.

import { config } from "dotenv";
config({ path: ".env.local" });

const tenantId = process.argv[2];

if (!tenantId) {
  console.error("Usage: npx tsx scripts/get-auth-url.ts <tenant_id>");
  process.exit(1);
}

// Dynamic import so it runs after dotenv has populated process.env — a
// static `import` here would get hoisted above the config() call above,
// and lib/supabase.ts (imported transitively by lib/google-calendar.ts)
// throws immediately if SUPABASE_URL isn't set yet. Wrapped in an async
// function since this file compiles to CommonJS, which doesn't support
// top-level await.
async function main() {
  const { getAuthUrl } = await import("../lib/google-calendar");
  console.log(getAuthUrl(tenantId));
}

main();
