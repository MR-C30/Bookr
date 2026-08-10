import crypto from "crypto";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;
const PAYFAST_URL = process.env.PAYFAST_URL;

if (!PAYFAST_MERCHANT_ID) {
  throw new Error("Missing required env var: PAYFAST_MERCHANT_ID");
}
if (!PAYFAST_MERCHANT_KEY) {
  throw new Error("Missing required env var: PAYFAST_MERCHANT_KEY");
}
if (!PAYFAST_PASSPHRASE) {
  throw new Error("Missing required env var: PAYFAST_PASSPHRASE");
}
if (!PAYFAST_URL) {
  throw new Error("Missing required env var: PAYFAST_URL");
}

// ---------------------------------------------------------------------------
// ZAR amount handling
// ---------------------------------------------------------------------------

export type DepositType = "fixed" | "percentage";

// Mirrors tenants.deposit_type / tenants.deposit_value from schema.sql.
// A 'fixed' deposit is capped at the total price so a customer is never
// charged more than the service costs (e.g. a R100 fixed deposit on a
// R50 add-on-free service charges R50, not R100).
export function calculateDepositAmount(
  totalPrice: number,
  depositType: DepositType,
  depositValue: number
): number {
  if (depositType === "fixed") {
    return Math.min(depositValue, totalPrice);
  }
  return Math.round(totalPrice * (depositValue / 100) * 100) / 100;
}

// Payfast requires amounts as strings with exactly 2 decimal places.
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

// ---------------------------------------------------------------------------
// Signature generation
// ---------------------------------------------------------------------------

// Payfast expects values encoded the way PHP's urlencode() encodes them,
// which differs from JS's encodeURIComponent() in a few places: spaces
// become '+' (not '%20'), and '~', '!', '\'', '(', ')', '*' get
// percent-encoded (encodeURIComponent leaves them alone).
function payfastEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
}

// NOTE: This implementation (field order preserved as given, PHP-urlencode-
// style encoding, blank fields excluded, passphrase appended last, MD5
// digest) is based on third-party write-ups cross-checking Payfast's
// documented Node.js signature bug, not a direct read of Payfast's own
// docs — the official docs page is a JS app that returned no content when
// fetched. If a sandbox checkout ever comes back with a signature-mismatch
// error, re-verify this function against developers.payfast.co.za/docs
// directly before assuming the bug is elsewhere.
export function generateSignature(
  fields: Record<string, string | number | undefined>,
  passphrase: string
): string {
  const pairs = Object.entries(fields)
    .filter(([key, value]) => key !== "signature" && value !== undefined && String(value) !== "")
    .map(([key, value]) => `${key}=${payfastEncode(String(value))}`);

  if (passphrase) {
    pairs.push(`passphrase=${payfastEncode(passphrase)}`);
  }

  return crypto.createHash("md5").update(pairs.join("&")).digest("hex");
}

// ---------------------------------------------------------------------------
// Checkout payload
// ---------------------------------------------------------------------------

export interface CheckoutFields {
  m_payment_id: string; // our reference, e.g. the appointment id
  amount: number; // deposit amount in ZAR, from calculateDepositAmount()
  item_name: string;
  item_description?: string;
  name_first?: string;
  email_address?: string;
  return_url: string;
  cancel_url: string;
  notify_url: string;
}

// Builds the full sandbox redirect URL (Payfast's GET-based checkout flow):
// merchant fields + the caller's fields + a signature computed over all of
// them, in this exact order. Field order must stay identical between the
// signature calculation and the query string, since the signature is only
// valid for the order it was generated with.
export function buildCheckoutUrl(fields: CheckoutFields): string {
  const orderedFields: Record<string, string> = {
    merchant_id: PAYFAST_MERCHANT_ID!,
    merchant_key: PAYFAST_MERCHANT_KEY!,
    return_url: fields.return_url,
    cancel_url: fields.cancel_url,
    notify_url: fields.notify_url,
    ...(fields.name_first ? { name_first: fields.name_first } : {}),
    ...(fields.email_address ? { email_address: fields.email_address } : {}),
    m_payment_id: fields.m_payment_id,
    amount: formatAmount(fields.amount),
    item_name: fields.item_name,
    ...(fields.item_description ? { item_description: fields.item_description } : {}),
  };

  const signature = generateSignature(orderedFields, PAYFAST_PASSPHRASE!);

  const queryString = [
    ...Object.entries(orderedFields).map(([key, value]) => `${key}=${payfastEncode(value)}`),
    `signature=${signature}`,
  ].join("&");

  return `${PAYFAST_URL}?${queryString}`;
}
