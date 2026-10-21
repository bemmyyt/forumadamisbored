// Staging helper: public feed only. Do not use for DMs, profiles or admin data.
export const API_BASE = "https://api.adamisbored.xyz/v1/forum";

async function getJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(API_BASE + path, { signal: controller.signal });
    if (!response.ok) throw Error("API HTTP " + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}

// Only the public feed may fall back to Firestore. Writes must fail closed.
export async function publicPosts(firebasePublicRead) {
  try {
    const data = await getJson("/posts");
    if (!Array.isArray(data.posts)) throw Error("Invalid API response");
    return { items: data.posts, source: "api", readOnly: false };
  } catch (_) {
    return { items: await firebasePublicRead(), source: "firebase", readOnly: true };
  }
}
export async function publicReplies(postId, firebasePublicRead) {
  if (!/^[a-zA-Z0-9]{1,100}$/.test(postId)) throw Error("Invalid post ID");
  try {
    const data = await getJson("/replies?postId=" + encodeURIComponent(postId));
    if (!Array.isArray(data.replies)) throw Error("Invalid API response");
    return { items: data.replies, source: "api", readOnly: false };
  } catch (_) {
    return { items: await firebasePublicRead(postId), source: "firebase", readOnly: true };
  }
}
export async function writeForum(path, method, payload, firebaseUser) {
  if (!firebaseUser) throw Error("Sign in first");
  const token = await firebaseUser.getIdToken();
  const response = await fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  if (!response.ok) throw Error("Forum write unavailable (HTTP " + response.status + ")");
  return response.status === 204 ? null : response.json();
}
