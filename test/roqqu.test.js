import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

const configNames = [
  "ROQQU_API_KEY",
  "ROQQU_STAGING_API_KEY",
  "ROQQU_MODE",
  "ROQQU_BASE_URL",
  "PUBLIC_URL"
];

function setConfig(values) {
  const previous = Object.fromEntries(configNames.map(name => [name, process.env[name]]));
  for (const name of configNames) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  return () => {
    for (const name of configNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

test("Roqqu requests use the documented test/live headers and form bodies", async () => {
  const originalFetch = globalThis.fetch;
  const restore = setConfig({
    ROQQU_API_KEY: "unit-test-key",
    ROQQU_MODE: "staging",
    ROQQU_BASE_URL: "https://service.roqqu.com/v1/",
    PUBLIC_URL: "https://ajo.example"
  });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith("/balances")
      ? { status: "success", data: { balance: { btc: 12 } } }
      : { status: "success", data: { payment_link: "https://pay.example/link" } };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    const api = await import(`../roqqu.js?test=${Date.now()}`);
    assert.equal(api.mode, "test");
    const balance = await api.getBalance({ email: "merchant@example.test", token: "btc" });
    assert.equal(balance.btc, 12);
    const payment = await api.createPaymentLink({
      reference: "ESU0123456789abcdef",
      amount: 1000,
      payer: "A Member",
      email: "member@example.test"
    });
    assert.equal(payment.url, "https://pay.example/link");
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.options.headers["x-staging-api-key"], "unit-test-key");
      assert.equal(call.options.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(call.options.method, "POST");
      assert.ok(call.url.startsWith("https://service.roqqu.com/v1/"));
    }
    assert.deepEqual(Object.fromEntries(calls[0].options.body), {
      email: "merchant@example.test",
      token: "btc"
    });
    const paymentFields = Object.fromEntries(calls[1].options.body);
    assert.equal(paymentFields.amount, "1000");
    assert.equal(paymentFields.payment_reference, "ESU0123456789abcdef");
    assert.equal(paymentFields.amount_currency, "ngn");
    assert.deepEqual(JSON.parse(paymentFields.customer_details), {
      email: "member@example.test",
      first_name: "A",
      last_name: "Member"
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("live Roqqu mode decrypts documented AES-CTR webhook payloads", async () => {
  const restore = setConfig({
    ROQQU_API_KEY: "0123456789abcdef0123456789abcdef-live",
    ROQQU_MODE: "live",
    ROQQU_BASE_URL: "https://service.roqqu.com/v1",
    PUBLIC_URL: "https://ajo.example"
  });
  try {
    const api = await import(`../roqqu.js?live=${Date.now()}`);
    assert.equal(api.mode, "live");
    const iv = "00112233445566778899aabbccddeeff";
    const cipher = crypto.createCipheriv(
      "aes-256-ctr",
      Buffer.from("0123456789abcdef0123456789abcdef"),
      Buffer.from(iv, "hex")
    );
    const hash = Buffer.concat([
      cipher.update(JSON.stringify({ event_type: "payment_link_completed" })),
      cipher.final()
    ]).toString("hex");
    assert.deepEqual(api.refFromWebhook({ hash }, iv), {
      event_type: "payment_link_completed"
    });
  } finally {
    restore();
  }
});
