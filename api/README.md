# Forum API foundation (staging only)

This is a **non-deployed** Node/Express API for `forum.adamisbored.xyz`, using the existing Firebase project and Firestore collections. No live forum files are changed by this foundation commit.

## What is included
- `GET /v1/forum/health`
- `GET /v1/forum/posts` (last 50 public-field posts)
- `GET /v1/forum/replies?postId=...` (up to 100)
- `POST /v1/forum/posts`, `POST /v1/forum/replies` (Firebase ID token required)
- `DELETE /v1/forum/posts/:id` (owner or configured admin UID required)
- CORS allowlist, body-size limit, per-IP rate limiting, no service account committed.
- **Write endpoints are OFF by default**, returning 503.

## Local/staging setup
Install Node 20+, then `cd api && npm install && cp .env.example .env`.
Create a Google Cloud/Firebase service account with the minimum permissions needed; store the JSON **outside the git checkout** and set `GOOGLE_APPLICATION_CREDENTIALS` in `.env`. Never paste or commit this key.
Then run `npm start`. The server binds only to `127.0.0.1:3001`. Set an Nginx HTTPS reverse proxy for `api.adamisbored.xyz` pointing to that loopback port. Configure CORS for the actual frontend origin.

## Important security and rollout limitations
- Do **not** turn on `ENABLE_WRITES` yet. The current website still writes directly to Firestore for posts, replies, users, bans and direct messages. Server-only authorization can be bypassed until Firestore Security Rules are reviewed and tightened.
- The current website's moderation is client-side. An API must enforce server-side policy before accepting public content. The sample API marks writes as `pending`, but the existing frontend does not hide pending content. Add a real moderation pipeline and approval-aware readers before production writes.
- Firestore rules are not in this repository. Do not deploy restrictive rules without first auditing user registration, DMs, profiles and admin flows; abrupt rule changes may break the live forum.
- Direct messages MUST NOT be exposed by public GET routes or a public read-only fallback. Any future DM route must verify that the requester belongs to that conversation.
- The old client displays data using Firestore `getDocs` and `getDoc`; frontend migration needs adapters and pagination. Retain Firebase Auth and use `await auth.currentUser.getIdToken()` for API calls.
- Emergency **read-only fallback**: when API is unavailable, publicly readable posts/replies may be loaded using limited Firebase rules or an independent static snapshot. All writes should fail closed, including profile/moderation/DM writes. This requires separate frontend work and rules changes.
- The admin UID must be explicitly configured; do not trust a username like "adam" for authorization.
- The API list endpoints are intentionally bounded; the existing site currently downloads whole collections, so pagination and rendering changes are required for feature parity.

## Deploy checklist
1. Implement backend moderation and hidden-pending handling.
2. Audit and update Firestore rules; verify DM privacy and account operations.
3. Modify and test the forum frontend to use API routes, with read-only fallback.
4. Deploy API on VPS + Nginx + TLS; test health, auth, rate limits, 403/401, offline fallback.
5. Only after all checks, enable writes and release frontend.
