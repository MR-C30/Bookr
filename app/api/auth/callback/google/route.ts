import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/google-calendar";

// This is the page Google redirects the browser back to after the tenant
// owner approves (or denies) Calendar access. It was set as the redirect
// URI when we built the consent link in getAuthUrl().
//
// Google appends two query params we care about:
//   - code:  a one-time code we exchange for real tokens
//   - state: the tenantId we originally passed into getAuthUrl(), echoed
//            back unchanged — this is how we know which tenant to save the
//            refresh token against (we never read tenantId from anywhere
//            else, like a session or a default value).
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  // If the tenant owner clicks "Cancel" on Google's consent screen, Google
  // redirects back with an `error` param instead of a `code`.
  const googleError = searchParams.get("error");
  if (googleError) {
    return NextResponse.redirect(
      new URL(`/?google_error=${encodeURIComponent(googleError)}`, request.url)
    );
  }

  const code = searchParams.get("code");
  const tenantId = searchParams.get("state");

  if (!code || !tenantId) {
    return NextResponse.redirect(
      new URL("/?google_error=missing_code_or_state", request.url)
    );
  }

  try {
    await exchangeCodeForTokens(code, tenantId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.redirect(
      new URL(`/?google_error=${encodeURIComponent(message)}`, request.url)
    );
  }

  return NextResponse.redirect(new URL("/?google_connected=1", request.url));
}
