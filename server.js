import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as roqqu from "./roqqu.js";

const PORT = Number(process.env.PORT || 3000);
const FILE = process.env.DATA_FILE || "./data.json";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASSWORD || "";
const SESSION_DAYS = 7;
const MAX_EVIDENCE_BYTES = 3 * 1024 * 1024;
const scrypt = promisify(crypto.scrypt);
if (roqqu.live && !PASS) {
  console.error("Set ADMIN_PASSWORD before using a Roqqu API key.");
  process.exit(1);
}

let db = {
  groups: [],
  paidRefs: {},
  payouts: {},
  users: [],
  sessions: {},
  invites: {},
  paymentRefs: {}
};
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
db.users ||= [];
db.sessions ||= {};
db.invites ||= {};
db.paymentRefs ||= {};
db.groups.forEach(group => {
  group.members ||= [];
  group.history ||= [];
  if (!group.ownerId) group.ownerId = PASS ? `admin:${USER}` : "local";
});
for (const [id, session] of Object.entries(db.sessions)) {
  if (!session.expiresAt || session.expiresAt <= Date.now()) delete db.sessions[id];
}
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
const same = (a, b) => {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const validEmail = value => typeof value === "string" &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const normalizeEmail = value => value.trim().toLowerCase();
const adminId = `admin:${USER}`;

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(part => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    const key = part.slice(0, index).trim();
    try { return [key, decodeURIComponent(part.slice(index + 1).trim())]; }
    catch { return [key, ""]; }
  }).filter(([key]) => key));
}

function resolveAuth(req) {
  const token = cookies(req).ajo_session;
  if (token) {
    const session = db.sessions[hash(token)];
    if (session && session.expiresAt > Date.now()) {
      if (session.userId.startsWith("admin:")) {
        return { id: session.userId, email: USER, isAdmin: true };
      }
      const account = db.users.find(user => user.id === session.userId);
      if (account) return { id: account.id, email: account.email, isAdmin: false };
    }
  }
  const authorization = req.headers.authorization || "";
  if (PASS && authorization.startsWith("Basic ")) {
    let credentials = "";
    try { credentials = Buffer.from(authorization.slice(6), "base64").toString(); } catch {}
    const separator = credentials.indexOf(":");
    if (separator >= 0 && same(credentials.slice(0, separator), USER) &&
        same(credentials.slice(separator + 1), PASS)) {
      return { id: adminId, email: USER, isAdmin: true };
    }
  }
  if (!PASS && db.users.length === 0 && !roqqu.live) {
    return { id: "local", email: "", isAdmin: false, local: true };
  }
  return null;
}

function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[hash(token)] = { userId, expiresAt: Date.now() + SESSION_DAYS * 86400000 };
  save();
  const secure = /^https:\/\//i.test(process.env.PUBLIC_URL || "");
  res.setHeader("Set-Cookie",
    `ajo_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}

function clearSession(req, res) {
  const token = cookies(req).ajo_session;
  if (token) delete db.sessions[hash(token)];
  save();
  res.setHeader("Set-Cookie", "ajo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function canManage(group, user) {
  return Boolean(user && group.ownerId === user.id);
}

function canView(group, user) {
  return canManage(group, user) ||
    Boolean(user && group.members.some(member => member.userId === user.id));
}

function internalRef(groupId, round, index) {
  return `${groupId}-${round}-${index}`;
}

function markPaid(reference, details = {}) {
  const [groupId, round, index] = reference.split("-");
  const group = db.groups.find(item => item.id === groupId);
  const member = group && group.members[Number(index)];
  if (!group || !member || group.round !== Number(round)) return false;
  member.paid = true;
  member.paymentStatus = roqqu.live ? "confirmed" : "practice";
  member.paymentRound = Number(round);
  member.paidAt = new Date().toISOString();
  if (details.transactionHash) member.transactionHash = details.transactionHash;
  db.paidRefs[reference] = Date.now();
  save();
  return true;
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

app.get("/api/session", (req, res) => {
  const user = resolveAuth(req);
  const authRequired = Boolean(PASS || db.users.length || roqqu.live);
  res.json({
    ok: !authRequired || Boolean(user),
    authRequired,
    user: user ? { id: user.id, email: user.email, admin: user.isAdmin } : null,
    mode: roqqu.mode,
    live: roqqu.live
  });
});

app.post("/api/login", async (req, res) => {
  const { user, email, password } = req.body || {};
  const identifier = typeof email === "string" ? email.trim() : user;
  if (typeof identifier !== "string" || typeof password !== "string") {
    return res.status(400).json({ ok: false, error: "Enter your email/username and password." });
  }
  if (PASS && same(identifier, USER) && same(password, PASS)) {
    setSession(res, adminId);
    return res.json({ ok: true });
  }
  const account = db.users.find(item => item.email === normalizeEmail(identifier));
  if (account) {
    const candidate = await scrypt(password, Buffer.from(account.salt, "hex"), 64);
    if (same(candidate, Buffer.from(account.passwordHash, "hex"))) {
      setSession(res, account.id);
      return res.json({ ok: true });
    }
  }
  if (!PASS && !db.users.length && !roqqu.live) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: "Wrong email/username or password." });
});

app.post("/api/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

function validInvite(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const id = hash(token);
  const invite = db.invites[id];
  if (!invite || invite.expiresAt <= Date.now()) return null;
  const group = db.groups.find(item => item.id === invite.groupId);
  const member = group && group.members[invite.memberIndex];
  if (!member || member.userId || typeof member.email !== "string" ||
      normalizeEmail(member.email) !== invite.email) return null;
  return { id, invite, group, member };
}

app.get("/api/invite/:token", (req, res) => {
  const result = validInvite(req.params.token);
  if (!result) return res.status(404).json({ error: "This invitation is invalid, expired, or already used." });
  res.json({
    group: result.group.name,
    member: result.member.name,
    email: result.invite.email
  });
});

app.post("/api/signup", async (req, res) => {
  const { token, email, password } = req.body || {};
  const result = validInvite(token);
  if (!result) return res.status(400).json({ error: "This invitation is invalid, expired, or already used." });
  if (!validEmail(email) || normalizeEmail(email) !== result.invite.email) {
    return res.status(400).json({ error: "Use the email address this invitation was sent to." });
  }
  if (typeof password !== "string" || password.length < 10) {
    return res.status(400).json({ error: "Choose a password with at least 10 characters." });
  }
  if (db.users.some(item => item.email === normalizeEmail(email))) {
    return res.status(409).json({ error: "An account already exists for this email. Sign in instead." });
  }
  const salt = crypto.randomBytes(16);
  const passwordHash = await scrypt(password, salt, 64);
  const account = {
    id: crypto.randomBytes(16).toString("hex"),
    email: normalizeEmail(email),
    salt: salt.toString("hex"),
    passwordHash: passwordHash.toString("hex")
  };
  result.member.userId = account.id;
  db.users.push(account);
  delete db.invites[result.id];
  save();
  setSession(res, account.id);
  res.status(201).json({ ok: true });
});

app.post("/api/webhook/roqqu", (req, res) => {
  const iv = req.get("x-staging-api-key") || req.get("x-api-key");
  const event = roqqu.refFromWebhook(req.body, iv);
  if (!event) {
    return res.sendStatus(400);
  }
  if (!["payment_link_completed", "payment_link_completed_overpaid", "payment_link_failed"].includes(event.event_type)) {
    return res.sendStatus(200);
  }
  const details = event.meta_data;
  const reference = details?.payment_reference;
  const mapping = typeof reference === "string" && db.paymentRefs[reference];
  if (!mapping) return res.sendStatus(200);
  const group = db.groups.find(item => item.id === mapping.groupId);
  const member = group && group.members[mapping.memberIndex];
  if (!member || group.round !== mapping.round ||
      member.paymentReference !== reference ||
      member.ref !== internalRef(group.id, mapping.round, mapping.memberIndex)) {
    return res.sendStatus(200);
  }
  if (event.event_type === "payment_link_completed" && details.status === "completed" &&
      Number(details.amount_required) === mapping.amount &&
      String(details.amount_currency || "").toLowerCase() === "ngn") {
    markPaid(member.ref, { transactionHash: details.hash });
  } else {
    member.paymentStatus = event.event_type === "payment_link_failed" ? "failed" : "review";
    member.paymentRound = group.round;
    save();
  }
  res.sendStatus(200);
});

app.get("/mock-pay/:ref", (req, res) => {
  if (roqqu.live || !/^[a-z0-9-]+$/.test(req.params.ref)) return res.sendStatus(404);
  res.type("html").send(`<meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:420px;margin:10vh auto;padding:0 16px"><h1>Practice payment</h1><p>No real money moves. Reference: ${req.params.ref}</p><form method=post><button style="font:inherit;padding:10px 16px">Simulate payment</button></form>`);
});

app.post("/mock-pay/:ref", (req, res) => {
  const reference = req.params.ref;
  if (roqqu.live || !/^[a-z0-9-]+$/.test(reference)) return res.sendStatus(404);
  if (!markPaid(reference)) return res.status(404).send("Payment reference not found or no longer active.");
  res.type("html").send("<body style=\"font:16px system-ui;padding:16px\">Practice payment recorded. You can close this page.");
});

app.use("/api", (req, res, next) => {
  const user = resolveAuth(req);
  if (!user) return res.status(401).json({ error: "Login required" });
  req.auth = user;
  next();
});

app.post("/api/invite/accept", (req, res) => {
  const result = validInvite(req.body?.token);
  if (!result) return res.status(400).json({ error: "This invitation is invalid, expired, or already used." });
  if (!req.auth.email || normalizeEmail(req.auth.email) !== result.invite.email) {
    return res.status(403).json({ error: "Sign in with the email address this invitation was sent to." });
  }
  result.member.userId = req.auth.id;
  delete db.invites[result.id];
  save();
  res.json({ ok: true });
});

app.get("/api/state", (req, res) => {
  const groups = db.groups.filter(group => canView(group, req.auth)).map(group => {
    const copy = structuredClone(group);
    const owner = canManage(group, req.auth);
    if (!owner) {
      copy.members.forEach(member => {
        if (member.userId !== req.auth.id) {
          delete member.email;
          delete member.payoutTo;
          delete member.link;
          delete member.ref;
          delete member.paymentReference;
          delete member.transactionHash;
        }
      });
    }
    return copy;
  });
  res.json({
    groups,
    live: roqqu.live,
    mode: roqqu.mode,
    user: { id: req.auth.id, email: req.auth.email, admin: req.auth.isAdmin }
  });
});

app.put("/api/state", (req, res) => {
  const groups = req.body?.groups;
  if (!Array.isArray(groups)) {
    return res.status(400).json({ error: "Bad circle data." });
  }
  const existing = new Map(db.groups.map(group => [group.id, group]));
  const editableGroups = groups.filter(group => {
    const previous = group && existing.get(group.id);
    return !previous || canManage(previous, req.auth);
  });
  if (editableGroups.some(group =>
    !group || typeof group.id !== "string" || !/^[a-z0-9]+$/.test(group.id) ||
    typeof group.name !== "string" || !group.name.trim() || group.name.length > 40 ||
    !Number.isSafeInteger(group.amount) || group.amount < 100 ||
    !Number.isInteger(group.round) || group.round < 0 ||
    !Array.isArray(group.members) || group.members.length < 3 || group.members.length > 30 ||
    group.round > group.members.length ||
    !["monthly", "weekly"].includes(group.freq))) {
    return res.status(400).json({ error: "Bad circle data." });
  }
  for (const group of editableGroups) {
    const previous = existing.get(group.id);
    if (group.members.some(member => !member || typeof member.name !== "string" ||
        !member.name.trim() || member.name.length > 80)) {
      return res.status(400).json({ error: "Every member needs a name." });
    }
    if (group.members.some(member => member.email && !validEmail(member.email))) {
      return res.status(400).json({ error: "Every member email must be valid." });
    }
    group.ownerId = req.auth.id;
    group.members.forEach((member, index) => {
      const oldMember = previous?.members[index];
      if (oldMember?.userId) member.userId = oldMember.userId;
      else delete member.userId;
      member.evidence = oldMember?.evidence || [];
      const ref = internalRef(group.id, group.round, index);
      const currentRoundStatus = oldMember?.paymentRound === group.round;
      if (currentRoundStatus && oldMember?.paymentStatus) {
        member.paymentStatus = oldMember.paymentStatus;
        member.paymentRound = oldMember.paymentRound;
      } else {
        delete member.paymentStatus;
        delete member.paymentRound;
      }
      if (roqqu.live) {
        member.paymentReference = currentRoundStatus ? oldMember.paymentReference : null;
        member.link = currentRoundStatus ? oldMember.link : null;
        member.ref = currentRoundStatus ? oldMember.ref : null;
        member.paid = Boolean(db.paidRefs[ref] ||
          (currentRoundStatus && oldMember?.paymentStatus === "confirmed"));
      } else if (db.paidRefs[ref]) {
        member.paid = true;
      }
    });
  }
  const submittedIds = new Set(editableGroups.map(group => group.id));
  db.groups = db.groups.filter(group => !canManage(group, req.auth) || submittedIds.has(group.id));
  for (const group of editableGroups) {
    const index = db.groups.findIndex(existingGroup => existingGroup.id === group.id);
    if (index >= 0) db.groups[index] = group;
    else db.groups.push(group);
  }
  save();
  res.json({ ok: true });
});

app.post("/api/invite", (req, res) => {
  const { groupId, index } = req.body || {};
  const group = db.groups.find(item => item.id === groupId);
  const memberIndex = Number(index);
  const member = group?.members[memberIndex];
  if (!group || !canManage(group, req.auth) || !member || !validEmail(member.email)) {
    return res.status(400).json({ error: "Add a valid email address to this member before inviting them." });
  }
  if (group.ownerId === "local" && !PASS) {
    return res.status(400).json({ error: "Set ADMIN_USER and ADMIN_PASSWORD before using member accounts." });
  }
  if (member.userId) return res.status(409).json({ error: "This member already has an account." });
  Object.keys(db.invites).forEach(id => {
    const invite = db.invites[id];
    if (invite.groupId === group.id && invite.memberIndex === memberIndex) delete db.invites[id];
  });
  const token = crypto.randomBytes(32).toString("hex");
  db.invites[hash(token)] = {
    groupId: group.id,
    memberIndex,
    email: normalizeEmail(member.email),
    expiresAt: Date.now() + 7 * 86400000
  };
  save();
  const base = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
  res.json({ url: `${base}/?invite=${token}` });
});

app.post("/api/link", async (req, res) => {
  try {
    const { groupId, index } = req.body || {};
    const group = db.groups.find(item => item.id === groupId);
    const memberIndex = Number(index);
    const member = group?.members[memberIndex];
    const permitted = group && canView(group, req.auth) &&
      (canManage(group, req.auth) || member?.userId === req.auth.id);
    if (!permitted || !member || group.round >= group.members.length || member.paid) {
      return res.status(400).json({ error: "Unknown member or contribution is not payable in this round." });
    }
    const reference = internalRef(group.id, group.round, memberIndex);
    if (member.link && member.ref === reference && member.paymentStatus !== "failed") {
      return res.json({ url: member.link, ref: reference });
    }
    const paymentReference = roqqu.live
      ? `ESU${crypto.randomBytes(8).toString("hex")}`
      : reference;
    const result = await roqqu.createPaymentLink({
      reference: paymentReference,
      amount: group.amount,
      payer: member.name,
      email: member.email
    });
    member.link = result.url;
    member.ref = reference;
    member.paymentReference = roqqu.live ? paymentReference : null;
    member.paymentStatus = "pending";
    member.paymentRound = group.round;
    if (roqqu.live) {
      db.paymentRefs[paymentReference] = {
        groupId: group.id,
        round: group.round,
        memberIndex,
        amount: Number(group.amount)
      };
    }
    save();
    res.json({ url: result.url, ref: reference });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/evidence", (req, res) => {
  const { groupId, index, name, mimeType, data } = req.body || {};
  const group = db.groups.find(item => item.id === groupId);
  const memberIndex = Number(index);
  const member = group?.members[memberIndex];
  if (!group || !member || !canView(group, req.auth) ||
      (member.userId !== req.auth.id && !canManage(group, req.auth))) {
    return res.status(403).json({ error: "You can only upload evidence for your own contribution." });
  }
  if (group.round >= group.members.length || member.paid) {
    return res.status(400).json({ error: "There is no unpaid contribution to attach evidence to." });
  }
  if (!["image/jpeg", "image/png", "application/pdf"].includes(mimeType) ||
      typeof name !== "string" || typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return res.status(400).json({ error: "Upload a JPG, PNG, or PDF proof file." });
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_EVIDENCE_BYTES) {
    return res.status(413).json({ error: "Evidence files must be smaller than 3 MB." });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(UPLOAD_DIR, id), bytes, { flag: "wx" });
  member.evidence ||= [];
  member.evidence.push({
    id,
    name: path.basename(name).slice(0, 120),
    mimeType,
    round: group.round,
    uploadedAt: new Date().toISOString()
  });
  save();
  res.status(201).json({ ok: true });
});

app.get("/api/evidence/:id", (req, res) => {
  const evidenceId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) return res.sendStatus(404);
  const group = db.groups.find(item => canView(item, req.auth) &&
    item.members.some(member => member.evidence?.some(file => file.id === evidenceId)));
  const entry = group?.members.flatMap(member => member.evidence || []).find(file => file.id === evidenceId);
  if (!entry || !group) return res.sendStatus(404);
  const safeName = entry.name.replace(/[^\w.-]/g, "_").slice(0, 120);
  res.type(entry.mimeType).set("Content-Disposition", `inline; filename="${safeName}"`)
    .sendFile(path.resolve(UPLOAD_DIR, evidenceId), error => {
      if (error && !res.headersSent) res.sendStatus(error.statusCode || 404);
    });
});

app.post("/api/balance", async (req, res) => {
  if (!req.auth.isAdmin) return res.status(403).json({ error: "Only the app owner can view the merchant balance." });
  const { email, token } = req.body || {};
  if (email !== undefined && !validEmail(email)) return res.status(400).json({ error: "Enter a valid merchant email." });
  if (token !== undefined && (typeof token !== "string" || !/^[a-z0-9]{2,10}$/i.test(token))) {
    return res.status(400).json({ error: "Enter a valid token symbol." });
  }
  try {
    const balance = await roqqu.getBalance({ email, token });
    res.json({ balance });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/payout", (req, res) => {
  const group = db.groups.find(item => item.id === req.body?.groupId);
  if (!group || !canManage(group, req.auth) || group.round >= group.members.length) {
    return res.status(400).json({ error: "Nothing to record for this circle." });
  }
  if (group.members.some(member => !member.paid)) {
    return res.status(400).json({ error: "Wait until Roqqu confirms all contributions." });
  }
  const reference = `${group.id}-${group.round}`;
  if (!db.payouts[reference]) {
    db.payouts[reference] = { id: `tracked-${reference}`, tracked: true };
    save();
  }
  res.json(db.payouts[reference]);
});

app.listen(PORT, () => {
  console.log(`Ajo running on http://localhost:${PORT} (${roqqu.mode} Roqqu mode)`);
});
