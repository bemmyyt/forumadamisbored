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
  if (data.banned === true || !data.username || String(data.username).toLowerCase().includes("ban"))
    return null;
  return data;
}
function validText(text) { return typeof text === "string" && text.trim().length >= 1 && text.trim().length <= 3000; }
function writingEnabled(req, res, next) { return enableWrites ? next() : err(res, 503, "Forum API is in read-only mode"); }

app.get("/v1/forum/health", (req, res) => res.json({ ok: true, writesEnabled: enableWrites }));
app.get("/v1/forum/posts", async (req, res, next) => {
  try {
    const snap = await db.collection("posts").orderBy("createdAt", "desc").limit(50).get();
    res.json({ posts: snap.docs.map(d => ({ id: d.id, ...publicPost(d.data()) })) });
  } catch (e) { next(e); }
});
app.get("/v1/forum/replies", async (req, res, next) => {
  try {
    const postId = req.query.postId;
    if (typeof postId !== "string" || !/^[a-zA-Z0-9]{1,100}$/.test(postId)) return err(res, 400, "Valid postId required");
    const snap = await db.collection("replies").where("postId", "==", postId).limit(100).get();
    res.json({ replies: snap.docs.map(d => ({ id: d.id, ...publicReply(d.data()) })) });
  } catch (e) { next(e); }
});
app.post("/v1/forum/posts", writingEnabled, requireUser, async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (!validText(text)) return err(res, 400, "Post text must contain 1–3000 characters");
    const profile = await allowedUser(req.user.uid);
    if (!profile) return err(res, 403, "Posting not permitted");
    // IMPORTANT: Enabling writes also requires a real server-side moderation policy.
    const data = { text: text.trim(), user: profile.username, uid: req.user.uid, createdAt: Date.now(), moderationStatus: "pending", toxic: false };
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
    if (!parent.exists) return err(res, 404, "Post not found");
    const data = { postId, text: text.trim(), user: profile.username, uid: req.user.uid, createdAt: Date.now(), moderationStatus: "pending" };
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
app.use((error, req, res, next) => {
  console.error("Forum API error:", error);
  if (error?.type === "entity.parse.failed") return err(res, 400, "Invalid JSON");
  if (error?.type === "entity.too.large") return err(res, 413, "Request too large");
  return err(res, 500, "Internal server error");
});
const port = Number(process.env.PORT || 3001);
app.listen(port, "127.0.0.1", () => console.log("Forum API listening on loopback port", port));
