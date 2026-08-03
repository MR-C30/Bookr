import { google } from "googleapis";
import { fromZonedTime } from "date-fns-tz";
import { supabaseAdmin } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ??
  "http://localhost:3000/api/auth/callback/google";

if (!GOOGLE_CLIENT_ID) {
  throw new Error("Missing required env var: GOOGLE_CLIENT_ID");
}
if (!GOOGLE_CLIENT_SECRET) {
  throw new Error("Missing required env var: GOOGLE_CLIENT_SECRET");
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Matches the shape stored in staff.working_hours, e.g.
// { mon: [["09:00","18:00"]], tue: [...], ..., sun: [] }
type DayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
type TimeRange = [string, string]; // ["09:00", "18:00"]
type WorkingHours = Partial<Record<DayKey, TimeRange[]>>;

export interface AvailableSlot {
  start: string; // ISO timestamp
  end: string; // ISO timestamp
}

export interface Appointment {
  summary: string;
  description?: string;
  startTime: string; // ISO timestamp
  endTime: string; // ISO timestamp
  attendeeEmail?: string;
}

export interface CreatedEvent {
  id: string;
  htmlLink: string | null | undefined;
}

// Thrown when the calendar owner has no usable Google refresh token on file
// (never connected, or the token was revoked) — the caller should send the
// tenant through the OAuth consent flow again.
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

// Thrown when createEvent's pre-insert freebusy check finds the requested
// time is no longer free (a second guard on top of the DB's own
// no_overlapping_appointments exclusion constraint).
export class SlotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotUnavailableError";
  }
}

const WEEKDAY_KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ---------------------------------------------------------------------------
// Resolving which tenant owns a given Google calendar
// ---------------------------------------------------------------------------

interface CalendarOwner {
  tenantId: string;
  timezone: string;
  refreshToken: string | null;
  workingHours: WorkingHours | null;
}

// A calendarId can belong to an individual staff member (staff.google_calendar_id,
// which also carries working_hours) or fall back to the tenant's own calendar
// (tenants.google_calendar_id, which has no working_hours of its own).
async function resolveCalendarOwner(calendarId: string): Promise<CalendarOwner> {
  const { data: staffRow, error: staffError } = await supabaseAdmin
    .from("staff")
    .select("tenant_id, working_hours")
    .eq("google_calendar_id", calendarId)
    .maybeSingle();

  if (staffError) {
    throw new Error(`Failed to look up staff for calendarId: ${staffError.message}`);
  }

  const tenantId = staffRow?.tenant_id ?? null;
  const workingHours = (staffRow?.working_hours as WorkingHours | undefined) ?? null;

  if (tenantId) {
    const tenant = await fetchTenant(tenantId);
    return { ...tenant, workingHours };
  }

  const { data: tenantRow, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id")
    .eq("google_calendar_id", calendarId)
    .maybeSingle();

  if (tenantError) {
    throw new Error(`Failed to look up tenant for calendarId: ${tenantError.message}`);
  }
  if (!tenantRow) {
    throw new Error(`No staff or tenant found for calendarId: ${calendarId}`);
  }

  const tenant = await fetchTenant(tenantRow.id);
  return { ...tenant, workingHours: null };
}

async function fetchTenant(
  tenantId: string
): Promise<Omit<CalendarOwner, "workingHours">> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("id, timezone, google_refresh_token")
    .eq("id", tenantId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load tenant ${tenantId}: ${error?.message}`);
  }

  return {
    tenantId: data.id,
    timezone: data.timezone,
    refreshToken: data.google_refresh_token,
  };
}

// ---------------------------------------------------------------------------
// OAuth2 client
// ---------------------------------------------------------------------------

function buildOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

// Builds an authorized calendar client for the tenant that owns `calendarId`,
// and keeps tenants.google_refresh_token in sync if Google rotates the
// refresh token during use.
async function getAuthorizedCalendarClient(calendarId: string) {
  const owner = await resolveCalendarOwner(calendarId);

  if (!owner.refreshToken) {
    throw new AuthRequiredError(
      `Tenant ${owner.tenantId} has not connected Google Calendar yet.`
    );
  }

  const oauth2Client = buildOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: owner.refreshToken });

  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.refresh_token) {
      await supabaseAdmin
        .from("tenants")
        .update({ google_refresh_token: tokens.refresh_token })
        .eq("id", owner.tenantId);
    }
  });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  return { calendar, owner };
}

// Generates the URL to send a tenant owner to for Google Calendar consent.
// `tenantId` is passed through as `state` so the callback route knows which
// tenant to save the resulting refresh token against.
export function getAuthUrl(tenantId: string): string {
  const oauth2Client = buildOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline", // required to receive a refresh token
    prompt: "consent", // required to receive a refresh token on repeat connects
    scope: [CALENDAR_SCOPE],
    state: tenantId,
  });
}

// Exchanges the OAuth callback's `code` for tokens and stores the refresh
// token on the tenant row. Called from app/api/auth/callback/google/route.ts.
export async function exchangeCodeForTokens(
  code: string,
  tenantId: string
): Promise<void> {
  const oauth2Client = buildOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. The tenant may need to revoke " +
        "prior access at https://myaccount.google.com/permissions and reconnect."
    );
  }

  const { error } = await supabaseAdmin
    .from("tenants")
    .update({ google_refresh_token: tokens.refresh_token })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`Failed to save refresh token: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Busy interval helpers
// ---------------------------------------------------------------------------

interface Interval {
  start: Date;
  end: Date;
}

function mergeBusyIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      last.end = interval.end > last.end ? interval.end : last.end;
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

function overlapsAny(start: Date, end: Date, intervals: Interval[]): boolean {
  return intervals.some(
    (busy) => start.getTime() < busy.end.getTime() && end.getTime() > busy.start.getTime()
  );
}

// ---------------------------------------------------------------------------
// getAvailableSlots
// ---------------------------------------------------------------------------

// `date` is a plain "YYYY-MM-DD" calendar date (interpreted in the tenant's
// timezone, per tenants.timezone). `durationMinutes` is the selected
// service's duration_minutes — slots are chunked at that size rather than a
// fixed default, since the same staff member/calendar can offer services of
// different lengths.
export async function getAvailableSlots(
  calendarId: string,
  date: string,
  durationMinutes: number
): Promise<AvailableSlot[]> {
  const { calendar, owner } = await getAuthorizedCalendarClient(calendarId);

  if (!owner.workingHours) {
    throw new Error(
      `No working_hours configured for calendarId ${calendarId} (only staff ` +
        "calendars carry working hours, not the tenant's own calendar)."
    );
  }

  const weekday = getWeekdayKeyInTimezone(date, owner.timezone);
  const ranges = owner.workingHours[weekday] ?? [];
  if (ranges.length === 0) {
    return []; // day off
  }

  const windows = ranges.map(([startStr, endStr]) => ({
    start: fromZonedTime(`${date}T${startStr}:00`, owner.timezone),
    end: fromZonedTime(`${date}T${endStr}:00`, owner.timezone),
  }));

  const dayStart = new Date(Math.min(...windows.map((w) => w.start.getTime())));
  const dayEnd = new Date(Math.max(...windows.map((w) => w.end.getTime())));

  const freebusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      timeZone: owner.timezone,
      items: [{ id: calendarId }],
    },
  });

  const busyRaw = freebusy.data.calendars?.[calendarId]?.busy ?? [];
  const busy = mergeBusyIntervals(
    busyRaw.map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }))
  );

  const durationMs = durationMinutes * 60 * 1000;
  const slots: AvailableSlot[] = [];

  for (const window of windows) {
    let slotStart = window.start;
    while (slotStart.getTime() + durationMs <= window.end.getTime()) {
      const slotEnd = new Date(slotStart.getTime() + durationMs);
      if (!overlapsAny(slotStart, slotEnd, busy)) {
        slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
      }
      slotStart = slotEnd;
    }
  }

  return slots;
}

// Resolves which working_hours key ("mon", "tue", ...) `date` falls on, as
// seen in `timezone` — not the server's local timezone.
function getWeekdayKeyInTimezone(date: string, timezone: string): DayKey {
  const noonUtc = fromZonedTime(`${date}T12:00:00`, timezone);
  const weekdayIndex = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  })
    .format(noonUtc)
    .toLowerCase();

  const match = WEEKDAY_KEYS.find((key) => weekdayIndex.startsWith(key));
  if (!match) {
    throw new Error(`Could not resolve weekday for date ${date} in ${timezone}`);
  }
  return match;
}

// ---------------------------------------------------------------------------
// createEvent
// ---------------------------------------------------------------------------

export async function createEvent(
  calendarId: string,
  appointment: Appointment
): Promise<CreatedEvent> {
  const { calendar, owner } = await getAuthorizedCalendarClient(calendarId);

  // Re-check the slot is still free immediately before booking. This is a
  // second guard alongside the DB's no_overlapping_appointments exclusion
  // constraint, not a replacement for it.
  const freebusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: appointment.startTime,
      timeMax: appointment.endTime,
      timeZone: owner.timezone,
      items: [{ id: calendarId }],
    },
  });

  const busy = freebusy.data.calendars?.[calendarId]?.busy ?? [];
  if (busy.length > 0) {
    throw new SlotUnavailableError(
      `Calendar ${calendarId} is no longer free between ${appointment.startTime} and ${appointment.endTime}.`
    );
  }

  const { data } = await calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: appointment.summary,
      description: appointment.description,
      start: { dateTime: appointment.startTime, timeZone: owner.timezone },
      end: { dateTime: appointment.endTime, timeZone: owner.timezone },
      attendees: appointment.attendeeEmail
        ? [{ email: appointment.attendeeEmail }]
        : undefined,
    },
  });

  return { id: data.id!, htmlLink: data.htmlLink };
}
