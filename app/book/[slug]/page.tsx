import { notFound } from "next/navigation";
import { addDays, format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { supabaseAdmin, supabasePublic } from "@/lib/supabase";
import {
  getAvailableSlots,
  AuthRequiredError,
  type AvailableSlot,
} from "@/lib/google-calendar";
import { Button } from "@/components/ui/button";

interface BookingPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; slot?: string }>;
}

export default async function BookingPage({
  params,
  searchParams,
}: BookingPageProps) {
  const { slug } = await params;
  const { date: dateParam, slot: slotParam } = await searchParams;

  // tenants has no public RLS select policy yet, so this lookup goes through
  // the service-role client. staff/services below use the anon client since
  // both already have "active rows are publicly readable" RLS policies.
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id, business_name, slug, timezone")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (tenantError) {
    throw new Error(`Failed to load tenant for slug ${slug}: ${tenantError.message}`);
  }
  if (!tenant) {
    notFound();
  }

  // .limit(1) alongside .maybeSingle() avoids a "multiple rows" error if
  // seed data ever ends up with more than one active staff/service row —
  // current phase scope is one of each, but this keeps the page resilient.
  const [staffResult, serviceResult] = await Promise.all([
    supabasePublic
      .from("staff")
      .select("id, full_name, google_calendar_id")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle(),
    supabasePublic
      .from("services")
      .select("id, name, description, duration_minutes, price")
      .eq("tenant_id", tenant.id)
      .eq("is_addon", false)
      .eq("is_active", true)
      .order("sort_order")
      .limit(1)
      .maybeSingle(),
  ]);

  if (staffResult.error) {
    throw new Error(
      `Failed to load staff for tenant ${tenant.id}: ${staffResult.error.message}`
    );
  }
  if (serviceResult.error) {
    throw new Error(
      `Failed to load service for tenant ${tenant.id}: ${serviceResult.error.message}`
    );
  }

  const staff = staffResult.data;
  const service = serviceResult.data;

  if (!staff || !service) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-16 text-center">
        <h1 className="text-2xl font-semibold">{tenant.business_name}</h1>
        <p className="text-muted-foreground">
          Online booking isn&apos;t set up for this business yet. Please check
          back soon.
        </p>
      </div>
    );
  }

  const selectedDate =
    dateParam ?? formatInTimeZone(new Date(), tenant.timezone, "yyyy-MM-dd");
  const prevDate = format(
    addDays(new Date(`${selectedDate}T12:00:00`), -1),
    "yyyy-MM-dd"
  );
  const nextDate = format(
    addDays(new Date(`${selectedDate}T12:00:00`), 1),
    "yyyy-MM-dd"
  );

  let slots: AvailableSlot[] = [];
  let calendarError: string | null = null;

  if (!staff.google_calendar_id) {
    calendarError = "Online booking isn't set up for this business yet.";
  } else {
    try {
      slots = await getAvailableSlots(
        staff.google_calendar_id,
        selectedDate,
        service.duration_minutes
      );
    } catch (error) {
      calendarError =
        error instanceof AuthRequiredError
          ? "Online booking is temporarily unavailable. Please check back soon."
          : "Something went wrong loading available times. Please try again.";
    }
  }

  const selectedSlot = slots.find((s) => s.start === slotParam) ?? null;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 p-8">
      <div className="w-full max-w-md space-y-1 text-center">
        <h1 className="text-2xl font-semibold">{tenant.business_name}</h1>
        <p className="text-muted-foreground">
          {service.name} · {service.duration_minutes} min · R{service.price}
        </p>
        {service.description && (
          <p className="text-sm text-muted-foreground">{service.description}</p>
        )}
      </div>

      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          nativeButton={false}
          render={<a href={`?date=${prevDate}`}>Previous day</a>}
        />
        <span className="font-medium">{selectedDate}</span>
        <Button
          variant="outline"
          nativeButton={false}
          render={<a href={`?date=${nextDate}`}>Next day</a>}
        />
      </div>

      {calendarError && (
        <p className="rounded-md bg-red-100 px-4 py-2 text-red-800 dark:bg-red-900 dark:text-red-100">
          {calendarError}
        </p>
      )}

      {!calendarError && slots.length === 0 && (
        <p className="text-muted-foreground">
          No times available this day — try another day.
        </p>
      )}

      {!calendarError && slots.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {slots.map((slot) => (
            <Button
              key={slot.start}
              variant={slot.start === slotParam ? "default" : "outline"}
              nativeButton={false}
              render={
                <a href={`?date=${selectedDate}&slot=${encodeURIComponent(slot.start)}`}>
                  {formatInTimeZone(new Date(slot.start), tenant.timezone, "h:mm a")}
                </a>
              }
            />
          ))}
        </div>
      )}

      {selectedSlot && (
        <form
          action="/api/checkout"
          method="POST"
          className="w-full max-w-md space-y-3 rounded-md border p-4"
        >
          <h2 className="font-medium">Your details</h2>
          <input type="hidden" name="tenant_id" value={tenant.id} />
          <input type="hidden" name="staff_id" value={staff.id} />
          <input type="hidden" name="service_id" value={service.id} />
          <input type="hidden" name="start_time" value={selectedSlot.start} />
          <input type="hidden" name="end_time" value={selectedSlot.end} />

          <div className="space-y-1">
            <label htmlFor="full_name" className="text-sm font-medium">
              Full name
            </label>
            <input
              id="full_name"
              name="full_name"
              required
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="phone" className="text-sm font-medium">
              Phone number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              required
              placeholder="+27821234567"
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <Button type="submit" className="w-full">
            Book {formatInTimeZone(selectedSlot.start, tenant.timezone, "h:mm a")}
          </Button>
        </form>
      )}
    </div>
  );
}
