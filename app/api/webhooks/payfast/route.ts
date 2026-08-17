import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { generateSignature } from "@/lib/payfast";
import {
  createEvent,
  AuthRequiredError,
  SlotUnavailableError,
} from "@/lib/google-calendar";

// Maps Payfast's ITN `payment_status` field to our own payments.status enum
// (see schema.sql). Anything we don't recognise falls back to "pending" so
// we still record the attempt instead of throwing it away.
const PAYMENT_STATUS_MAP: Record<string, "pending" | "complete" | "failed" | "cancelled"> = {
  COMPLETE: "complete",
  FAILED: "failed",
  PENDING: "pending",
  CANCELLED: "cancelled",
};

// Payfast POSTs the ITN (Instant Transaction Notification) as
// application/x-www-form-urlencoded, same as the checkout form we built in
// app/api/checkout/route.ts.
export async function POST(request: NextRequest) {
  const formData = await request.formData();

  // Build the fields object by walking formData in the order Payfast sent
  // it -- generateSignature() must see fields in that same order, per the
  // ordering note in lib/payfast.ts.
  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    fields[key] = value.toString();
  }

  // ---------------------------------------------------------------------
  // 1. Verify the signature before trusting anything in this payload.
  //    We deliberately skip Payfast's other two recommended checks
  //    (source-IP allowlisting, the server-to-server /validate postback)
  //    for now -- see CLAUDE.md Known Issues, must add before going live.
  // ---------------------------------------------------------------------
  // lib/payfast.ts already throws at import time if PAYFAST_PASSPHRASE is
  // missing, so it's guaranteed to be set here.
  const expectedSignature = generateSignature(fields, process.env.PAYFAST_PASSPHRASE!);
  if (fields.signature !== expectedSignature) {
    console.error("Payfast ITN signature mismatch", { received: fields.signature, fields });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ---------------------------------------------------------------------
  // 2. Look up the appointment this ITN is for (m_payment_id was set to
  //    appointments.id when we built the checkout URL).
  // ---------------------------------------------------------------------
  const appointmentId = fields.m_payment_id;
  const { data: appointment, error: appointmentLookupError } = await supabaseAdmin
    .from("appointments")
    .select(
      "id, tenant_id, staff_id, primary_service_id, customer_id, start_time, end_time, status, google_calendar_event_id"
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (appointmentLookupError) {
    console.error(`Failed to look up appointment ${appointmentId}:`, appointmentLookupError);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
  if (!appointment) {
    // Nothing we can do with a retry here -- the appointment will never
    // appear. Log it clearly and tell Payfast we're done so it stops resending.
    console.error(`Payfast ITN for unknown appointment id: ${appointmentId}`);
    return new NextResponse("OK", { status: 200 });
  }

  const paymentStatus = PAYMENT_STATUS_MAP[fields.payment_status] ?? "pending";

  // ---------------------------------------------------------------------
  // 3. Non-success ITNs (pending/failed/cancelled): record for the audit
  //    trail only, don't confirm the appointment or touch the calendar.
  // ---------------------------------------------------------------------
  if (paymentStatus !== "complete") {
    const { error: paymentInsertError } = await supabaseAdmin.from("payments").insert({
      tenant_id: appointment.tenant_id,
      appointment_id: appointment.id,
      provider: "payfast",
      provider_reference: fields.pf_payment_id,
      amount: Number(fields.amount_gross ?? fields.amount ?? 0),
      currency: "ZAR",
      status: paymentStatus,
      raw_webhook_payload: fields,
    });
    if (paymentInsertError) {
      console.error(`Failed to record non-complete payment for ${appointment.id}:`, paymentInsertError);
      return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
    }
    return new NextResponse("OK", { status: 200 });
  }

  // ---------------------------------------------------------------------
  // 4. Payment complete. Confirm the appointment + insert the payment row,
  //    unless a previous (retried) ITN already did this -- Payfast's docs
  //    warn the same ITN can be sent more than once.
  // ---------------------------------------------------------------------
  if (appointment.status !== "confirmed") {
    const { error: appointmentUpdateError } = await supabaseAdmin
      .from("appointments")
      .update({ status: "confirmed" })
      .eq("id", appointment.id);

    if (appointmentUpdateError) {
      console.error(`Failed to confirm appointment ${appointment.id}:`, appointmentUpdateError);
      return NextResponse.json({ error: "Failed to confirm appointment" }, { status: 500 });
    }

    const { error: paymentInsertError } = await supabaseAdmin.from("payments").insert({
      tenant_id: appointment.tenant_id,
      appointment_id: appointment.id,
      provider: "payfast",
      provider_reference: fields.pf_payment_id,
      amount: Number(fields.amount_gross ?? fields.amount ?? 0),
      currency: "ZAR",
      status: "complete",
      raw_webhook_payload: fields,
    });

    if (paymentInsertError) {
      console.error(`Failed to record payment for ${appointment.id}:`, paymentInsertError);
      return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------
  // 5. Sync to Google Calendar. The payment is already captured and
  //    recorded at this point, so a calendar failure must NOT undo any of
  //    the above -- log it clearly and still return 200. If the event was
  //    already created by a previous ITN, skip this step entirely.
  // ---------------------------------------------------------------------
  if (!appointment.google_calendar_event_id) {
    try {
      const [{ data: staff }, { data: tenant }, { data: service }, { data: customer }] =
        await Promise.all([
          supabaseAdmin
            .from("staff")
            .select("google_calendar_id, full_name")
            .eq("id", appointment.staff_id)
            .single(),
          supabaseAdmin
            .from("tenants")
            .select("google_calendar_id")
            .eq("id", appointment.tenant_id)
            .single(),
          supabaseAdmin
            .from("services")
            .select("name")
            .eq("id", appointment.primary_service_id)
            .single(),
          supabaseAdmin
            .from("customers")
            .select("full_name, phone, email")
            .eq("id", appointment.customer_id)
            .single(),
        ]);

      // A staff member's own calendar takes priority; fall back to the
      // tenant's calendar if they don't have one set (same fallback
      // lib/google-calendar.ts's resolveCalendarOwner uses).
      const calendarId = staff?.google_calendar_id ?? tenant?.google_calendar_id ?? null;
      if (!calendarId) {
        throw new AuthRequiredError(`No Google Calendar connected for appointment ${appointment.id}`);
      }

      const event = await createEvent(calendarId, {
        summary: `${service?.name ?? "Appointment"} — ${customer?.full_name ?? "Customer"}`,
        description: customer?.phone ? `Phone: ${customer.phone}` : undefined,
        startTime: appointment.start_time,
        endTime: appointment.end_time,
        attendeeEmail: customer?.email ?? undefined,
      });

      const { error: eventIdUpdateError } = await supabaseAdmin
        .from("appointments")
        .update({ google_calendar_event_id: event.id })
        .eq("id", appointment.id);

      if (eventIdUpdateError) {
        console.error(`Failed to store calendar event id for ${appointment.id}:`, eventIdUpdateError);
      }
    } catch (error) {
      // Payment is already confirmed -- log this for manual follow-up
      // (e.g. tenant needs to reconnect Google Calendar, see CLAUDE.md
      // Known Issues) rather than failing the webhook.
      if (error instanceof AuthRequiredError || error instanceof SlotUnavailableError) {
        console.error(
          `Calendar sync failed for confirmed appointment ${appointment.id} (${error.name}): ${error.message}`
        );
      } else {
        console.error(`Calendar sync failed for confirmed appointment ${appointment.id}:`, error);
      }
    }
  }

  return new NextResponse("OK", { status: 200 });
}
