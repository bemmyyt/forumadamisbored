"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "api", "server.js"), "utf8");
const rules = fs.readFileSync(path.join(root, "firestore.rules.candidate"), "utf8");

test("browser cannot directly write Firestore documents", () => {
  assert.doesNotMatch(html, /\b(?:addDoc|setDoc|updateDoc|deleteDoc)\s*\(/);
});
test("browser does not directly fetch private user documents", () => {
  assert.doesNotMatch(html, /\bgetDoc\s*\(/);
  assert.doesNotMatch(html, /getDocs\s*\(\s*collection\(db,\s*['"]users['"]/);
});
test("browser uses verified API for account and profile operations", () => {
  for (const endpoint of ["/v1/forum/me", "/v1/forum/me/profile", "/v1/forum/profiles/", "/v1/forum/username/"]) {
    assert.ok(html.includes(endpoint), "Missing frontend endpoint " + endpoint);
  }
});
test("private account records and DM writes are blocked in candidate rules", () => {
  const users = rules.match(/match \/users\/\{uid\} \{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(users, "Missing users rules");
  assert.match(users, /allow read: if false;/);
  assert.match(users, /allow create, update: if false;/);
  const dms = rules.match(/match \/directMessages\/\{messageId\} \{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(dms, "Missing DM rules");
  assert.match(dms, /allow write: if false;/);
  assert.match(dms, /senderUid == request\.auth\.uid/);
  assert.match(dms, /recipientUid == request\.auth\.uid/);
});
test("server checks Firebase ID tokens and protects admin routes", () => {
  assert.match(server, /verifyIdToken\(match\[1\], true\)/);
  assert.match(server, /function requireAdmin\(/);
  assert.match(server, /admin\/users", requireUser, requireAdmin/);
  assert.match(server, /admin\/users\/:uid\/ban", writingEnabled, requireUser, requireAdmin/);
});
test("server fails closed on disabled writes and moderation errors", () => {
  assert.match(server, /function writingEnabled\(/);
  assert.match(server, /enableWrites \? next\(\) : err\(res, 503/);
  assert.match(server, /Moderation unavailable/);
  assert.match(server, /return moderateWithExistingModel\(text\)/);
});
test("public profile response does not project private account fields", () => {
  const projection = server.match(/const profileProjection = \(id, d\) => \(\{([\s\S]*?)\}\);/)?.[1];
  assert.ok(projection, "Missing public profile projection");
  assert.doesNotMatch(projection, /\b(?:email|banReason|banned|roles|isAdmin|uidToken)\s*:/);
});
