"use strict";
// Opt-in smoke test against a staging API. Does not require credentials and
// does not create or delete any Firestore data.
const assert = require("node:assert/strict");
const base = process.env.FORUM_STAGING_API;
if (!base) {
  console.error("Set FORUM_STAGING_API to the staging API origin, e.g. https://staging-api.example.com");
  process.exit(2);
}
const origin = new URL(base);
if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1")
  throw new Error("Staging URL must use HTTPS (except localhost)");
const url = p => new URL("/v1/forum" + p, origin).toString();
async function request(path, options = {}) {
  const response = await fetch(url(path), { ...options, signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  return { status: response.status, body, json: () => JSON.parse(body) };
}
(async () => {
  const health = await request("/health");
  assert.equal(health.status, 200, "Health endpoint failed");
  assert.equal(health.json().ok, true);
  assert.equal(health.json().writesEnabled, false, "Staging writes MUST be disabled");
  const feed = await request("/feed");
  assert.equal(feed.status, 200, "Public feed failed");
  assert.ok(Array.isArray(feed.json().posts), "Feed posts missing");
  assert.ok(Array.isArray(feed.json().replies), "Feed replies missing");
  for (const p of ["/me", "/dms", "/admin/users"]) {
    const response = await request(p);
    assert.equal(response.status, 401, "Unauthenticated endpoint exposed: " + p);
  }
  for (const p of ["/posts", "/replies", "/dms", "/me/profile"]) {
    const response = await request(p, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 503, "Write was not blocked: " + p);
  }
  console.log("Read-only staging smoke test passed. No data was written.");
})().catch(e => { console.error(e); process.exitCode = 1; });
