// All Roqqu calls live in this file. Without ROQQU_API_KEY the app runs in practice mode.
// Fill the three spots marked ">>> FROM DOCS" using the Roqqu API Services docs
// (roqqu-api-services.gitbook.io/ras). Use a TEST key first.
const KEY = process.env.ROQQU_API_KEY;
const BASE = process.env.ROQQU_BASE_URL;
const PUBLIC = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
export const live = Boolean(KEY);

const mockPaid = new Set();
export const mockPay = ref => mockPaid.add(ref);

async function request(method, path, body) {
  if (!BASE || path.startsWith("TODO")) {
    throw new Error("Roqqu live mode is not set up yet: set ROQQU_BASE_URL and fill in the endpoints in roqqu.js.");
  }
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}` // >>> FROM DOCS: ASSUMPTION. Change to the auth header Roqqu specifies.
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Roqqu ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// Ask a member to pay one contribution. Returns { url } to send to them.
export async function createPaymentLink({ reference, amount, description, payer }) {
  if (!live) return { url: `${PUBLIC}/mock-pay/${reference}` };
  // >>> FROM DOCS: payment link endpoint, request fields, response shape.
  const r = await request("POST", "TODO/payment-links", { reference, amount, description, payer });
  return { url: r.url };
}

// Has this contribution actually been paid? The app only trusts this answer, never a webhook body.
export async function isPaid(reference) {
  if (!live) return mockPaid.has(reference);
  // >>> FROM DOCS: how to look up a payment or transaction by reference, and which field says it is paid.
  const r = await request("GET", `TODO/payment-links/${encodeURIComponent(reference)}`);
  return r.status === "paid";
}

// Send the pot to the member whose turn it is. `reference` is unique per round, so it cannot be paid twice.
export async function sendPayout({ reference, amount, to, name }) {
  if (!live) return { id: "mock-" + reference, mock: true };
  if (!to) throw new Error(`${name} has no payout address saved.`);
  // >>> FROM DOCS: send/withdraw endpoint, destination fields, currency, response shape.
  const r = await request("POST", "TODO/send", { reference, amount, to });
  return { id: r.id };
}

// Pull our payment reference out of a webhook. Optional: the server also polls isPaid every 30s.
export function refFromWebhook(body) {
  if (!live) return body && body.reference;
  return null; // >>> FROM DOCS: decrypt/parse the webhook and return the reference.
}
