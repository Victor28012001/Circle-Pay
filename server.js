import "dotenv/config";
import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as roqqu from "./roqqu.js";

const PORT = process.env.PORT || 3000;
const FILE = process.env.DATA_FILE || "./data.json";
const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASSWORD;
if (roqqu.live && !PASS) { console.error("Set ADMIN_PASSWORD before using a Roqqu key."); process.exit(1); }

let db = { groups: [], paidRefs: {}, payouts: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));

function apply(ref) {
  const [gid, round, i] = ref.split("-");
  const g = db.groups.find(x => x.id === gid);
  if (g && g.round === +round && g.members[+i]) g.members[+i].paid = true;
}
async function verify(ref) {
  if (db.paidRefs[ref]) return true;
  try {
    if (await roqqu.isPaid(ref)) { db.paidRefs[ref] = Date.now(); apply(ref); save(); return true; }
  } catch (e) { console.error("verify", ref, e.message); }
  return false;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Public routes: the provider's webhook and the practice-mode payment page.
app.post("/api/webhook/roqqu", async (req, res) => {
  res.sendStatus(200);
  const ref = roqqu.refFromWebhook(req.body);
  if (typeof ref === "string" && /^[a-z0-9-]+$/.test(ref)) await verify(ref); // re-checked with Roqqu, so a fake webhook cannot mark anything paid
});
app.get("/mock-pay/:ref", (req, res) => {
  if (roqqu.live || !/^[a-z0-9-]+$/.test(req.params.ref)) return res.sendStatus(404);
  res.type("html").send(`<meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:420px;margin:10vh auto;padding:0 16px"><h1>Practice payment</h1><p>No real money moves. Reference: ${req.params.ref}</p><form method=post><button style="font:inherit;padding:10px 16px">Simulate payment</button></form>`);
});
app.post("/mock-pay/:ref", async (req, res) => {
  if (roqqu.live || !/^[a-z0-9-]+$/.test(req.params.ref)) return res.sendStatus(404);
  roqqu.mockPay(req.params.ref); await verify(req.params.ref);
  res.type("html").send("<body style=\"font:16px system-ui;padding:16px\">Payment received. You can close this page.");
});

// Everything below needs the admin login.
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
app.use((req, res, next) => {
  if (!PASS) return next();
  const [u, p] = Buffer.from((req.headers.authorization || "").slice(6), "base64").toString().split(/:(.*)/s);
  if (u && same(u, USER) && same(p || "", PASS)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Ajo"').status(401).send("Login required");
});

app.get("/api/state", (req, res) => res.json({ groups: db.groups, live: roqqu.live }));
app.put("/api/state", (req, res) => {
  const gs = req.body.groups;
  if (!Array.isArray(gs) || gs.some(g => !g || !/^[a-z0-9]+$/.test(g.id) || !Array.isArray(g.members))) return res.status(400).json({ error: "Bad data" });
  gs.forEach(g => g.members.forEach((m, i) => { if (db.paidRefs[`${g.id}-${g.round}-${i}`]) m.paid = true; }));
  db.groups = gs; save(); res.json({ ok: true });
});
app.post("/api/link", async (req, res) => {
  try {
    const g = db.groups.find(x => x.id === req.body.groupId), i = +req.body.index, m = g && g.members[i];
    if (!m || g.round >= g.members.length) return res.status(400).json({ error: "Unknown member or finished cycle" });
    const ref = `${g.id}-${g.round}-${i}`;
    const out = await roqqu.createPaymentLink({ reference: ref, amount: g.amount, description: `${g.name}, round ${g.round + 1}`, payer: m.name });
    m.link = out.url; m.ref = ref; save();
    res.json({ url: out.url, ref });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/api/payout", async (req, res) => {
  try {
    const g = db.groups.find(x => x.id === req.body.groupId);
    if (!g || g.round >= g.members.length) return res.status(400).json({ error: "Nothing to pay out" });
    if (g.members.some(m => !m.paid)) return res.status(400).json({ error: "Not everyone has paid yet" });
    const ref = `${g.id}-${g.round}`, to = g.members[g.round];
    if (!db.payouts[ref]) { db.payouts[ref] = await roqqu.sendPayout({ reference: ref, amount: g.amount * g.members.length, to: to.payoutTo, name: to.name }); save(); }
    res.json(db.payouts[ref]);
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

setInterval(async () => {
  const refs = [];
  db.groups.forEach(g => g.members.forEach((m, i) => { if (m.ref && !m.paid && m.ref === `${g.id}-${g.round}-${i}`) refs.push(m.ref); }));
  for (const r of refs) await verify(r);
}, 30000);

app.listen(PORT, () => console.log(`Ajo running on http://localhost:${PORT} (${roqqu.live ? "live Roqqu mode" : "practice mode"})`));
