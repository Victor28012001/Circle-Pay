import crypto from "node:crypto";

const KEY = process.env.ROQQU_STAGING_API_KEY || process.env.ROQQU_API_KEY;
const configuredMode = (process.env.ROQQU_MODE || "staging").toLowerCase();
const staging = Boolean(process.env.ROQQU_STAGING_API_KEY) || configuredMode !== "live";
const BASE = (process.env.ROQQU_BASE_URL || "https://service.roqqu.com/v1").replace(/\/+$/, "");
const PUBLIC = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");

export const live = Boolean(KEY);
export const mode = !KEY ? "practice" : staging ? "test" : "live";

async function request(path, fields) {
  if (!KEY) throw new Error("Roqqu API key is not configured.");
  const headers = {
    [staging ? "x-staging-api-key" : "x-api-key"]: KEY
  };
  const options = { method: fields ? "POST" : "GET", headers };
  if (fields) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = new URLSearchParams(fields);
  }

  const response = await fetch(`${BASE}/${path.replace(/^\/+/, "")}`, options);
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Roqqu returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok || result.status === "fail") {
    throw new Error(`Roqqu request failed (HTTP ${response.status}): ${result.message || "request rejected"}`);
  }
  return result;
}

export async function getBalance({ email, token }) {
  if (!live) throw new Error("Set a Roqqu API key to check balances.");
  const fields = {};
  if (email) fields.email = email;
  if (token) fields.token = token;
  const result = await request("balances", fields);
  if (result.status !== "success" || !result.data?.balance) {
    throw new Error("Roqqu did not return a balance.");
  }
  return result.data.balance;
}

export async function createPaymentLink({ reference, amount, payer, email }) {
  if (!live) return { url: `${PUBLIC}/mock-pay/${reference}` };
  if (!/^https:\/\//i.test(PUBLIC)) {
    throw new Error("Set PUBLIC_URL to the app's public HTTPS address before creating live payment links.");
  }
  if (!email) throw new Error(`${payer} needs an email address before creating a Roqqu payment link.`);

  const names = payer.trim().split(/\s+/);
  const result = await request("payment-links", {
    amount: String(amount),
    customer_details: JSON.stringify({
      email,
      first_name: names[0] || payer,
      last_name: names.slice(1).join(" ") || names[0] || payer
    }),
    payment_reference: reference,
    success_url: `${PUBLIC}/?payment=success`,
    cancel_url: `${PUBLIC}/?payment=cancelled`,
    amount_currency: "ngn"
  });
  const data = result.data;
  if (result.status !== "success" || typeof data?.payment_link !== "string") {
    throw new Error("Roqqu did not return a payment link.");
  }
  return { url: data.payment_link };
}

export function refFromWebhook(body, iv) {
  if (!live || typeof body?.hash !== "string" || !/^[0-9a-f]+$/i.test(body.hash) ||
      typeof iv !== "string" || !/^[0-9a-f]{32}$/i.test(iv)) return null;
  try {
    const key = Buffer.from(KEY.slice(0, 32), "utf8");
    if (key.length !== 32) return null;
    const decipher = crypto.createDecipheriv("aes-256-ctr", key, Buffer.from(iv, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(body.hash, "hex")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}
