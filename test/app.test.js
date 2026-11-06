import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajo-app-test-"));
let child;
let baseUrl;
let startupOutput = "";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function json(response) {
  return response.json();
}

function cookie(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0];
}

async function request(pathname, options = {}, sessionCookie) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(options.headers || {})
    }
  });
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      ADMIN_USER: "circle-admin",
      ADMIN_PASSWORD: "test-admin-password-123",
      ROQQU_API_KEY: "",
      ROQQU_STAGING_API_KEY: "",
      ROQQU_MODE: "staging",
      DATA_FILE: path.join(tempDir, "data.json"),
      UPLOAD_DIR: path.join(tempDir, "uploads")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", data => { startupOutput += data; });
  child.stderr.on("data", data => { startupOutput += data; });

  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup: ${startupOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Server did not start: ${startupOutput}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("admin invites a contributor, who can upload evidence and only access their circles", async () => {
  const sessionResponse = await request("/api/session");
  const session = await json(sessionResponse);
  assert.equal(session.ok, false);
  assert.equal(session.mode, "practice");

  const loginResponse = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ user: "circle-admin", password: "test-admin-password-123" })
  });
  assert.equal(loginResponse.status, 200);
  const adminCookie = cookie(loginResponse);
  assert.ok(adminCookie);

  const group = {
    id: "testcircle",
    name: "Test Circle",
    amount: 1000,
    freq: "monthly",
    start: "2026-11-06",
    round: 0,
    cycles: 0,
    members: [
      { name: "A Member", email: "member@example.test", paid: false },
      { name: "B Member", email: "second@example.test", paid: false },
      { name: "C Member", email: "third@example.test", paid: false }
    ],
    history: []
  };
  const saveResponse = await request("/api/state", {
    method: "PUT",
    body: JSON.stringify({ groups: [group] })
  }, adminCookie);
  assert.equal(saveResponse.status, 200);

  const linkResponse = await request("/api/link", {
    method: "POST",
    body: JSON.stringify({ groupId: group.id, index: 0 })
  }, adminCookie);
  const link = await json(linkResponse);
  assert.equal(linkResponse.status, 200);
  assert.match(link.url, /\/mock-pay\/testcircle-0-0$/);
  const simulatedPayment = await request("/mock-pay/testcircle-0-0", { method: "POST" });
  assert.equal(simulatedPayment.status, 200);

  const inviteResponse = await request("/api/invite", {
    method: "POST",
    body: JSON.stringify({ groupId: group.id, index: 1 })
  }, adminCookie);
  const invite = await json(inviteResponse);
  assert.equal(inviteResponse.status, 200);
  const token = new URL(invite.url).searchParams.get("invite");
  assert.ok(token);
  const inviteInfo = await json(await request(`/api/invite/${token}`));
  assert.equal(inviteInfo.email, "second@example.test");

  const signupResponse = await request("/api/signup", {
    method: "POST",
    body: JSON.stringify({ token, email: inviteInfo.email, password: "contributor-password-123" })
  });
  assert.equal(signupResponse.status, 201);
  const memberCookie = cookie(signupResponse);
  assert.ok(memberCookie);

  const stateResponse = await request("/api/state", {}, memberCookie);
  const state = await json(stateResponse);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].members[1].email, "second@example.test");
  assert.equal(state.groups[0].members[0].paid, true);
  assert.equal("email" in state.groups[0].members[2], false);

  const proofResponse = await request("/api/evidence", {
    method: "POST",
    body: JSON.stringify({
      groupId: group.id,
      index: 1,
      name: "receipt.png",
      mimeType: "image/png",
      data: Buffer.from("test evidence").toString("base64")
    })
  }, memberCookie);
  assert.equal(proofResponse.status, 201);

  const ownerState = await json(await request("/api/state", {}, adminCookie));
  const proofId = ownerState.groups[0].members[1].evidence[0].id;
  const proofFetch = await request(`/api/evidence/${proofId}`, {}, memberCookie);
  assert.equal(proofFetch.status, 200);
  assert.equal(await proofFetch.text(), "test evidence");

  const changedGroup = { ...state.groups[0], name: "Unauthorized edit" };
  await request("/api/state", {
    method: "PUT",
    body: JSON.stringify({ groups: [changedGroup] })
  }, memberCookie);
  const unchanged = await json(await request("/api/state", {}, memberCookie));
  assert.equal(unchanged.groups[0].name, "Test Circle");

  const newCircle = {
    ...group,
    id: "membercircle",
    name: "Member's Circle",
    members: group.members.map(member => ({ ...member, userId: undefined, paid: false }))
  };
  const ownCircle = await request("/api/state", {
    method: "PUT",
    body: JSON.stringify({ groups: [...state.groups, newCircle] })
  }, memberCookie);
  assert.equal(ownCircle.status, 200);
  const withOwnCircle = await json(await request("/api/state", {}, memberCookie));
  assert.deepEqual(withOwnCircle.groups.map(item => item.id).sort(), ["membercircle", "testcircle"]);
});
