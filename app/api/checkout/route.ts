import { NextRequest, NextResponse } from "next/server";
import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { supabaseAdmin, supabasePublic } from "@/lib/supabase";
import { calculateDepositAmount, buildCheckoutUrl } from "@/lib/payfast";

// Loose E.164-ish check. This is the real trust boundary -- the booking
// page's <input type="tel" required> is client-side only and bypassable.
const PHONE_PATTERN = /^\+?[0-9]{9,15}$/;

// Handles the booking page's <form method="POST" action="/api/checkout">,
// so the body is application/x-www-form-urlencoded, not JSON.
export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const tenantId = formData.get("tenant_id")?.toString();
  const staffId = formData.get("staff_id")?.toString();
  const serviceId = formData.get("service_id")?.toString();
  const startTimeRaw = formData.get("start_time")?.toString();
  const fullName = formData.get("full_name")?.toString().trim();
  const phone = formData.get("phone")?.toString().trim();
  // end_time is posted too, but we deliberately don't read it -- see below.

  if (!tenantId || !staffId || !serviceId || !startTimeRaw || !fullName || !phone) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (!PHONE_PATTERN.test(phone)) {
    return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  }

  const startTime = new Date(startTimeRaw);
  if (Number.isNaN(startTime.getTime()) || startTime.getTime() < Date.now()) {
    return NextResponse.json({ error: "Invalid start_time" }, { status: 400 });
  }

  // tenants has no public RLS select policy, so this goes through the
  // service-role client -- same pattern as app/book/[slug]/page.tsx.
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id, slug, timezone, deposit_type, deposit_value")
    .eq("id", tenantId)
    .eq("is_active", true)
    .maybeSingle();

  if (tenantError) {
    throw new Error(`Failed to load tenant ${tenantId}: ${tenantError.message}`);
  }
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const [staffResult, serviceResult] = await Promise.all([
    supabasePublic
      .from("staff")
      .select("id, tenant_id")
      .eq("id", staffId)
      .eq("is_active", true)
      .maybeSingle(),
    supabasePublic
      .from("services")
      .select("id, tenant_id, name, price, duration_minutes")
      .eq("id", serviceId)
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  if (staffResult.error) {
    throw new Error(`Failed to load staff ${staffId}: ${staffResult.error.message}`);
  }
  if (serviceResult.error) {
    throw new Error(`Failed to load service ${serviceId}: ${serviceResult.error.message}`);
  }

  const staff = staffResult.data;
  const service = serviceResult.data;

  // Guard against a tampered staff_id/service_id from another tenant --
  // these arrive as hidden form fields, not resolved server-side here.
  if (!staff || staff.tenant_id !== tenant.id) {
    return NextResponse.json({ error: "Staff not found for this tenant" }, { status: 400 });
  }
  if (!service || service.tenant_id !== tenant.id) {
    return NextResponse.json({ error: "Service not found for this tenant" }, { status: 400 });
  }

  // Don't trust the posted end_time -- always derive it from the service's
  // own duration so a tampered end_time can't reserve a longer slot than
  // the deposit is calculated for.
  const endTime = addMinutes(startTime, service.duration_minutes);

  // customers has no public insert policy either -- find-or-create via the
  // service role. Reuses the existing name on repeat bookings from the same
  // phone number rather than overwriting it.
  const { data: existingCustomer, error: customerLookupError } = await supabaseAdmin
    .from("customers")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("phone", phone)
    .maybeSingle();

  if (customerLookupError) {
    throw new Error(`Failed to look up customer: ${customerLookupError.message}`);
  }

  let customerId: string | undefined = existingCustomer?.id;
  if (!customerId) {
    const { data: newCustomer, error: customerInsertError } = await supabaseAdmin
      .from("customers")
      .insert({ tenant_id: tenant.id, full_name: fullName, phone })
      .select("id")
      .single();

    if (customerInsertError || !newCustomer) {
      throw new Error(`Failed to create customer: ${customerInsertError?.message}`);
    }
    customerId = newCustomer.id;
  }

  const totalPrice = service.price;
  const depositAmount = calculateDepositAmount(
    totalPrice,
    tenant.deposit_type,
    tenant.deposit_value
  );

  const { data: appointment, error: appointmentError } = await supabaseAdmin
    .from("appointments")
    .insert({
      tenant_id: tenant.id,
      customer_id: customerId,
      staff_id: staff.id,
      primary_service_id: service.id,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      status: "pending_payment",
      total_price: totalPrice,
      deposit_amount: depositAmount,
    })
    .select("id")
    .single();

  if (appointmentError) {
    // 23P01 = exclusion_violation -- the DB's no_overlapping_appointments
    // constraint (schema.sql) is the source of truth for double-booking,
    // not an application-level check.
    if (appointmentError.code === "23P01") {
      const date = formatInTimeZone(startTime, tenant.timezone, "yyyy-MM-dd");
      return NextResponse.redirect(
        new URL(`/book/${tenant.slug}?date=${date}&error=slot_taken`, request.url)
      );
    }
    throw new Error(`Failed to create appointment: ${appointmentError.message}`);
  }

  const origin = request.nextUrl.origin;

  // notify_url is called server-to-server by Payfast, so it must be a real
  // publicly-reachable address -- unlike return_url/cancel_url (just browser
  // redirects), request.nextUrl.origin isn't reliable for this if we're ever
  // behind a tunnel/proxy in dev, so it comes from its own env var instead.
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!publicBaseUrl) {
    throw new Error("Missing required env var: PUBLIC_BASE_URL");
  }

  const checkoutUrl = buildCheckoutUrl({
    m_payment_id: appointment.id,
    amount: depositAmount,
    item_name: `${service.name} deposit`,
    name_first: fullName,
    return_url: `${origin}/book/${tenant.slug}?checkout=pending`,
    cancel_url: `${origin}/book/${tenant.slug}?checkout=cancelled`,
    notify_url: `${publicBaseUrl}/api/webhooks/payfast`,
  });

  // TEMPORARY: lib/payfast.ts's signature logic hasn't been verified
  // against a real Payfast sandbox transaction yet. Remove this once a
  // sandbox checkout completes without a signature-mismatch error.
  console.log("Payfast checkout URL:", checkoutUrl);

  return NextResponse.redirect(checkoutUrl, 303);
}
