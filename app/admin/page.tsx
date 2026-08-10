import { getAuthUrl } from "@/lib/google-calendar";
import { Button } from "@/components/ui/button";

// TEMPORARY: there's no owner login/dashboard yet, so this page is hardcoded
// to our one seeded tenant (Classic Cuts). Once real tenant-owner auth
// exists, this should come from the logged-in owner's session instead.
const TENANT_ID = "6412ecd0-e971-41b8-a160-9f274a3235df";

interface AdminPageProps {
  searchParams: Promise<{ google_connected?: string; google_error?: string }>;
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const { google_connected, google_error } = await searchParams;
  const authUrl = getAuthUrl(TENANT_ID);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-16">
      <h1 className="text-2xl font-semibold">Bookr Admin</h1>

      {google_connected && (
        <p className="rounded-md bg-green-100 px-4 py-2 text-green-800 dark:bg-green-900 dark:text-green-100">
          Google Calendar connected successfully.
        </p>
      )}

      {google_error && (
        <p className="rounded-md bg-red-100 px-4 py-2 text-red-800 dark:bg-red-900 dark:text-red-100">
          Google Calendar connection failed: {google_error}
        </p>
      )}

      <Button render={<a href={authUrl}>Connect Google Calendar</a>} />
    </div>
  );
}
