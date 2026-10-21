"use strict";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
const origins = (process.env.ALLOWED_ORIGINS || "https://forum.adamisbored.xyz").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) { cb(null, !origin || origins.includes(origin)); }, methods: ["GET","POST","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json({ limit: "16kb" }));
app.use("/v1/forum", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

const err = (res, status, message) => res.status(status).json({ error: message });
const visibleContent = d => !d.moderationStatus || d.moderationStatus === "approved";
const publicPost = d => ({
  text: typeof d.text === "string" ? d.text : "",
  user: typeof d.user === "string" ? d.user : "Unknown user",
  uid: typeof d.uid === "string" ? d.uid : null,
  createdAt: typeof d.createdAt === "number" ? d.createdAt : null,
  avatar: typeof d.avatar === "string" ? d.avatar : null,
  toxic: d.toxic === true,
  moderationStatus: typeof d.moderationStatus === "string" ? d.moderationStatus : null
});
const publicReply = d => ({
  postId: typeof d.postId === "string" ? d.postId : "",
  text: typeof d.text === "string" ? d.text : "",
  user: typeof d.user === "string" ? d.user : "Unknown user",
  uid: typeof d.uid === "string" ? d.uid : null,
  createdAt: typeof d.createdAt === "number" ? d.createdAt : null,
  avatar: typeof d.avatar === "string" ? d.avatar : null
});
const enableWrites = process.env.ENABLE_WRITES === "true";
const admins = new Set((process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean));

async function requireUser(req, res, next) {
  const match = /^Bearer (.+)$/i.exec(req.get("authorization") || "");
  if (!match) return err(res, 401, "Firebase ID token required");
  try {
    req.user = await admin.auth().verifyIdToken(match[1], true);
    return next();
  } catch (_) { return err(res, 401, "Invalid or expired token"); }
}
async function allowedUser(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  if (data.banned === true || typeof data.username !== "string" || !data.username.trim())
    return null;
  return data;
}
function validText(text) { return typeof text === "string" && text.trim().length >= 1 && text.trim().length <= 3000; }

// Reuse the forum's existing Xenova/toxic-bert classifier on the server.
// Lazy-load once, cache it, and reject all writes if initialization/inference fails.
let toxicBertPromise;
async function moderateWithExistingModel(text) {
  try {
    if (!toxicBertPromise) {
      toxicBertPromise = import("@huggingface/transformers")
        .then(({ pipeline }) => pipeline("text-classification", "Xenova/toxic-bert"))
        .catch(error => { toxicBertPromise = null; throw error; });
    }
    const classifier = await toxicBertPromise;
    const result = await classifier(text, { top_k: null });
    const predictions = Array.isArray(result[0]) ? result[0] : result;
    if (!Array.isArray(predictions) || predictions.length === 0 ||
        predictions.some(p => typeof p.label !== "string" || !Number.isFinite(p.score)))
      throw new Error("Invalid toxicity prediction");
    // Preserve the frontend's existing threshold and labels.
    return !predictions.some(p => p.label !== "non-toxic" && p.score >= 0.8);
  } catch (error) {
    console.error("Local moderation failed:", error?.message || "unknown error");
    throw Object.assign(new Error("Moderation unavailable"), { status: 503 });
  }
}

/**
 * Trusted moderation gateway. The external service must be controlled by the
 * operator and respond with { approved: true|false }. No client-provided
 * toxicity or approval fields are trusted. Failure always rejects the write.
 */
async function moderateText(text, category) {
  // Lightweight moderation uses no ML model. This is basic anti-spam only,
  // not a substitute for human review or abuse reporting.
  if (process.env.MODERATION_PROVIDER === "lightweight") {
    const value = text.trim();
    if (/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/.test(value)) return false;
    if (/(.)\\1{29,}/u.test(value)) return false;
    const links = value.split("http://").length - 1 + value.split("https://").length - 1;
    if (links > 3) return false;
    if (value.length > 100 && new Set(value.toLowerCase().split(/\\s+/)).size <= 2) return false;
    return true;
  }
  if (process.env.MODERATION_PROVIDER === "local-toxic-bert") {
    return moderateWithExistingModel(text);
  }
  const url = process.env.MODERATION_URL;
  const key = process.env.MODERATION_API_KEY;
  if (!url || !key) throw Object.assign(new Error("Moderation not configured"), { status: 503 });
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw Object.assign(new Error("Moderation requires HTTPS"), { status: 503 });
  try {
    const response = await fetch(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ text, category }),
      signal: AbortSignal.timeout(5000),
      redirect: "error"
    });
    if (!response.ok) throw new Error("Moderation HTTP failure");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) throw new Error("Moderation response is not JSON");
    const body = await response.text();
    if (body.length > 4096) throw new Error("Moderation response too large");
    const result = JSON.parse(body);
    if (typeof result?.approved !== "boolean") throw new Error("Invalid moderation response");
    return result.approved;
  } catch (_) {
    // Network errors, timeouts, redirects, invalid responses and policy failures
    // all fail closed, without leaking moderation-provider details to clients.
    throw Object.assign(new Error("Moderation unavailable"), { status: 503 });
  }
}

function writingEnabled(req, res, next) { return enableWrites ? next() : err(res, 503, "Forum API is in read-only mode"); }


// DM reads are always authenticated; never return the full collection to a client.
const dmPublic = doc => {
  const d = doc.data();
  return { id: doc.id, senderUid: d.senderUid, recipientUid: d.recipientUid,
    text: typeof d.text === "string" ? d.text : "", createdAt: Number(d.createdAt) || 0,
    toxic: d.toxic === true };
};
app.get("/v1/forum/dms", requireUser, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const messages = db.collection("directMessages");
    const [sent, received] = await Promise.all([
      messages.where("senderUid", "==", uid).limit(500).get(),
      messages.where("recipientUid", "==", uid).limit(500).get()
    ]);
    const merged = new Map();
    for (const doc of [...sent.docs, ...received.docs]) merged.set(doc.id, dmPublic(doc));
    const all = [...merged.values()].sort((a,b) => b.createdAt - a.createdAt);
    const partner = req.query.partner;
    if (partner !== undefined && (typeof partner !== "string" || !/^[a-zA-Z0-9]{1,128}$/.test(partner)))
      return err(res, 400, "Invalid partner UID");
    res.set("Cache-Control", "no-store");
    res.json({ messages: partner ? all.filter(d =>
      (d.senderUid === uid && d.recipientUid === partner) ||
      (d.senderUid === partner && d.recipientUid === uid)) : all });
  } catch (e) { next(e); }
});


app.post("/v1/forum/dms", writingEnabled, requireUser, async (req, res, next) => {
  try {
    const { recipientUid, text } = req.body || {};
    if (typeof recipientUid !== "string" || !/^[a-zA-Z0-9]{1,128}$/.test(recipientUid)
        || recipientUid === req.user.uid || !validText(text))
      return err(res, 400, "Valid recipient and message text required");
    const [sender, recipient] = await Promise.all([
      allowedUser(req.user.uid), allowedUser(recipientUid)
    ]);
    if (!sender || !recipient) return err(res, 403, "Messaging not permitted");
    if (!(await moderateText(text.trim(), "dm"))) return err(res, 422, "Message blocked by moderation");
    const data = {
      senderUid: req.user.uid, recipientUid,
      conversationId: [req.user.uid, recipientUid].sort().join("__"),
      text: text.trim(), toxic: false, createdAt: Date.now()
    };
    const created = await db.collection("directMessages").add(data);
    res.set("Cache-Control", "no-store");
    return res.status(201).json({ id: created.id });
  } catch (e) { next(e); }
});

// Profile writes are owned by the API; clients cannot set ban/admin fields.
app.post("/v1/forum/me/profile", writingEnabled, requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(k => !["username", "bio", "avatar", "resetUsername"].includes(k)))
      return err(res, 400, "Unsupported profile fields");
    const ref = db.collection("users").doc(req.user.uid);
    const update = {};
    if (body.resetUsername === true) {
      if (body.username !== undefined) return err(res, 400, "Conflicting username fields");
      update.username = "";
    }
    if (body.username !== undefined) {
      if (typeof body.username !== "string" || !/^[a-zA-Z0-9_]{1,20}$/.test(body.username))
        return err(res, 400, "Invalid username");
      update.username = body.username;
    }
    if (body.bio !== undefined) {
      if (typeof body.bio !== "string" || body.bio.length > 1000) return err(res, 400, "Invalid bio");
      update.bio = body.bio;
    }
    if (body.avatar !== undefined) {
      if (typeof body.avatar !== "string" || body.avatar.length > 12000 ||
          !(body.avatar.startsWith("data:image/png;base64,") ||
            body.avatar.startsWith("data:image/jpeg;base64,") ||
            /^https:\/\//.test(body.avatar)))
        return err(res, 400, "Invalid avatar");
      update.avatar = body.avatar;
    }
    if (!Object.keys(update).length) return err(res, 400, "No profile changes");
    // Legacy users did not have username claim documents. Check the existing
    // names before reserving a new claim. All NEW claims are atomic below.
    const desired = typeof update.username === "string" && update.username
      ? update.username.toLowerCase() : null;
    if (desired) {
      const legacy = await db.collection("users").get();
      if (legacy.docs.some(d => d.id !== req.user.uid &&
          typeof d.data().username === "string" &&
          d.data().username.toLowerCase() === desired))
        return err(res, 409, "Username already taken");
    }
    const outcome = await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      const existing = current.exists ? current.data() : {};
      if (existing.banned === true) return "banned";
      const oldName = typeof existing.username === "string" && existing.username
        ? existing.username.toLowerCase() : null;
      const nextName = body.resetUsername === true ? null : desired || oldName;
      const oldClaim = oldName ? db.collection("usernameClaims").doc(oldName) : null;
      const newClaim = nextName ? db.collection("usernameClaims").doc(nextName) : null;
      // Firestore transactions require all reads before writes.
      const oldClaimSnap = oldClaim ? await tx.get(oldClaim) : null;
      const newClaimSnap = newClaim && (!oldClaim || oldClaim.path !== newClaim.path)
        ? await tx.get(newClaim) : oldClaimSnap;
      if (newClaimSnap?.exists && newClaimSnap.data().uid !== req.user.uid) return "taken";
      if (oldClaimSnap?.exists && oldClaimSnap.data().uid !== req.user.uid) return "taken";
      if (oldClaim && oldClaim.path !== newClaim?.path && oldClaimSnap?.exists)
        tx.delete(oldClaim);
      if (newClaim) tx.set(newClaim, { uid: req.user.uid, claimedAt: Date.now() });
      const data = { ...update };
      if (desired && !existing.backupname) data.backupname = update.username;
      if (!current.exists) {
        data.createdAt = Date.now();
        data.uid = req.user.uid;
        data.email = req.user.email || null;
      }
      tx.set(ref, data, { merge: true });
      return "ok";
    });
    if (outcome === "banned") return err(res, 403, "Profile changes not permitted");
    if (outcome === "taken") return err(res, 409, "Username already taken");
    res.set("Cache-Control", "no-store");
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Public profiles intentionally exclude email, bans, auth and internal flags.
const profileProjection = (id, d) => ({
  uid: id,
  username: typeof d.username === "string" ? d.username : "",
  bio: typeof d.bio === "string" ? d.bio : "",
  avatar: typeof d.avatar === "string" ? d.avatar : "",
  rank: typeof d.rank === "string" ? d.rank : "forum user",
  badges: Array.isArray(d.badges) ? d.badges.filter(v => typeof v === "string").slice(0,20) : [],
  createdAt: d.createdAt || null
});
app.get("/v1/forum/profiles/:uid", async (req, res, next) => {
  try {
    const uid = req.params.uid;
    if (!/^[a-zA-Z0-9]{1,128}$/.test(uid)) return err(res, 400, "Invalid UID");
    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists) return err(res, 404, "Profile not found");
    res.json({ profile: profileProjection(doc.id, doc.data()) });
  } catch(e) { next(e); }
});
app.get("/v1/forum/username/:name", async (req, res, next) => {
  try {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9_]{1,20}$/.test(name)) return err(res, 400, "Invalid username");
    const claim = await db.collection("usernameClaims").doc(name.toLowerCase()).get();
    if (claim.exists) return res.json({ uid: claim.data().uid });
    // Compatibility with pre-migration users without username claims.
    const legacy = await db.collection("users").get();
    const match = legacy.docs.find(d => typeof d.data().username === "string" &&
      d.data().username.toLowerCase() === name.toLowerCase());
    res.json({ uid: match ? match.id : null });
  } catch(e) { next(e); }
});
app.get("/v1/forum/me", requireUser, async (req, res, next) => {
  try {
    const profile = await db.collection("users").doc(req.user.uid).get();
    const data = profile.exists ? profile.data() : {};
    res.set("Cache-Control", "no-store");
    res.json({ uid: req.user.uid, isAdmin: admins.has(req.user.uid), banned: data.banned === true, banReason: data.banned === true ? (typeof data.banReason === "string" ? data.banReason : "Banned by moderator") : null, username: typeof data.username === "string" ? data.username : "" });
  } catch (e) { next(e); }
});
app.get("/v1/forum/health", (req, res) => res.json({ ok: true, writesEnabled: enableWrites, moderationConfigured: ["local-toxic-bert", "lightweight"].includes(process.env.MODERATION_PROVIDER) || Boolean(process.env.MODERATION_URL && process.env.MODERATION_API_KEY) }));
app.get("/v1/forum/feed", async (req, res, next) => {
  try {
    const [posts, replies] = await Promise.all([
      db.collection("posts").orderBy("createdAt", "desc").limit(50).get(),
      db.collection("replies").limit(500).get()
    ]);
    const visiblePosts = posts.docs.filter(d => visibleContent(d.data()));
    const ids = new Set(visiblePosts.map(d => d.id));
    res.json({
      posts: visiblePosts.map(d => ({ id: d.id, ...publicPost(d.data()) })),
      replies: replies.docs.filter(d => ids.has(d.data().postId) && visibleContent(d.data()))
        .map(d => ({ id: d.id, ...publicReply(d.data()) }))
    });
  } catch (e) { next(e); }
});
app.get("/v1/forum/posts", async (req, res, next) => {
  try {
    const snap = await db.collection("posts").orderBy("createdAt", "desc").limit(50).get();
    res.json({ posts: snap.docs.filter(d => visibleContent(d.data())).map(d => ({ id: d.id, ...publicPost(d.data()) })) });
  } catch (e) { next(e); }
});
app.get("/v1/forum/replies", async (req, res, next) => {
  try {
    const postId = req.query.postId;
    if (typeof postId !== "string" || !/^[a-zA-Z0-9]{1,100}$/.test(postId)) return err(res, 400, "Valid postId required");
    const snap = await db.collection("replies").where("postId", "==", postId).limit(100).get();
    res.json({ replies: snap.docs.filter(d => visibleContent(d.data())).map(d => ({ id: d.id, ...publicReply(d.data()) })) });
  } catch (e) { next(e); }
});
app.post("/v1/forum/posts", writingEnabled, requireUser, async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (!validText(text)) return err(res, 400, "Post text must contain 1–3000 characters");
    const profile = await allowedUser(req.user.uid);
    if (!profile) return err(res, 403, "Posting not permitted");
    if (!(await moderateText(text.trim(), "post"))) return err(res, 422, "Post blocked by moderation");
    const data = { text: text.trim(), user: profile.username, uid: req.user.uid, createdAt: Date.now(), moderationStatus: "approved", toxic: false };
    if (typeof profile.avatar === "string") data.avatar = profile.avatar;
    const ref = await db.collection("posts").add(data);
    res.status(201).json({ id: ref.id });
  } catch (e) { next(e); }
});
app.post("/v1/forum/replies", writingEnabled, requireUser, async (req, res, next) => {
  try {
    const { postId, text } = req.body || {};
    if (typeof postId !== "string" || !/^[a-zA-Z0-9]{1,100}$/.test(postId) || !validText(text))
      return err(res, 400, "Valid postId and reply text required");
    const [profile, parent] = await Promise.all([allowedUser(req.user.uid), db.collection("posts").doc(postId).get()]);
    if (!profile) return err(res, 403, "Reply not permitted");
    if (!parent.exists || !visibleContent(parent.data())) return err(res, 404, "Post not found");
    if (!(await moderateText(text.trim(), "reply"))) return err(res, 422, "Reply blocked by moderation");
    const data = { postId, text: text.trim(), user: profile.username, uid: req.user.uid, createdAt: Date.now(), moderationStatus: "approved" };
    if (typeof profile.avatar === "string") data.avatar = profile.avatar;
    const ref = await db.collection("replies").add(data);
    res.status(201).json({ id: ref.id });
  } catch (e) { next(e); }
});
app.delete("/v1/forum/posts/:id", writingEnabled, requireUser, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9]{1,100}$/.test(id)) return err(res, 400, "Invalid post ID");
    const ref = db.collection("posts").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return err(res, 404, "Post not found");
    if (snap.data().uid !== req.user.uid && !admins.has(req.user.uid)) return err(res, 403, "Not permitted");
    await ref.delete();
    res.status(204).end();
  } catch (e) { next(e); }
});
// Admin privileges are granted only by server-controlled Firebase UIDs.
function requireAdmin(req, res, next) {
  if (!admins.has(req.user.uid)) return err(res, 403, "Admin permission required");
  return next();
}
app.get("/v1/forum/admin/users", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection("users").limit(500).get();
    res.set("Cache-Control", "no-store");
    res.json({ users: snap.docs.map(doc => {
      const d = doc.data();
      return { id: doc.id, username: typeof d.username === "string" ? d.username : "",
        banned: d.banned === true, banReason: typeof d.banReason === "string" ? d.banReason : "",
        badges: Array.isArray(d.badges) ? d.badges.filter(x => typeof x === "string").slice(0, 20) : [] };
    }) });
  } catch (e) { next(e); }
});
app.post("/v1/forum/admin/users/:uid/ban", writingEnabled, requireUser, requireAdmin, async (req, res, next) => {
  try {
    const uid = req.params.uid;
    if (!/^[a-zA-Z0-9]{1,128}$/.test(uid) || uid === req.user.uid || admins.has(uid))
      return err(res, 400, "Invalid ban target");
    const reason = req.body?.reason;
    if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 300)
      return err(res, 400, "Ban reason must be 1–300 characters");
    const ref = db.collection("users").doc(uid);
    if (!(await ref.get()).exists) return err(res, 404, "User not found");
    await ref.update({ banned: true, banCode: "manual", banReason: reason.trim() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/v1/forum/admin/users/:uid/unban", writingEnabled, requireUser, requireAdmin, async (req, res, next) => {
  try {
    const uid = req.params.uid;
    if (!/^[a-zA-Z0-9]{1,128}$/.test(uid)) return err(res, 400, "Invalid user UID");
    const ref = db.collection("users").doc(uid);
    if (!(await ref.get()).exists) return err(res, 404, "User not found");
    await ref.update({ banned: false, banCode: null, banReason: null });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete("/v1/forum/admin/replies/:id", writingEnabled, requireUser, requireAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9]{1,100}$/.test(id)) return err(res, 400, "Invalid reply ID");
    const ref = db.collection("replies").doc(id);
    if (!(await ref.get()).exists) return err(res, 404, "Reply not found");
    await ref.delete();
    res.status(204).end();
  } catch (e) { next(e); }
});
app.use((error, req, res, next) => {
  console.error("Forum API error:", error);
  if (error?.status === 503) return err(res, 503, "Moderation service unavailable");
  if (error?.type === "entity.parse.failed") return err(res, 400, "Invalid JSON");
  if (error?.type === "entity.too.large") return err(res, 413, "Request too large");
  return err(res, 500, "Internal server error");
});
const port = Number(process.env.PORT || 3001);
app.listen(port, "127.0.0.1", () => console.log("Forum API listening on loopback port", port));
