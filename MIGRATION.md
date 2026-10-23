# Forum API migration status

This branch deliberately leaves the existing production forum behavior unchanged unless the URL contains `?forumApiPreview=1`.

## Preview
After deploying the **matching backend commit** on Webdock, open `https://forum.adamisbored.xyz/?forumApiPreview=1` on a staging deployment of this branch. This reads the first 50 posts plus a bounded reply collection through `GET /v1/forum/feed`. If the API is unreachable, it falls back to existing Firebase reads. Posting, replying and post deletion are disabled in preview. Other account/admin/DM functionality is not migrated and MUST NOT be considered read-only.

**Do not merge as a completed migration.** This is a reviewable, staged implementation. Do not turn on `ENABLE_WRITES` yet.

## Blocking work before production
1. Inspect the deployed Firebase Security Rules (not included in this repository). They must deny direct writes to posts and replies and protect all user/admin/DM documents; verify that the current account handoff, registration, profiles, bans, and DM flows still work after their API migration.
2. Move every privileged mutation from browser Firebase SDK to server-side authenticated endpoints, including admin moderation and ban operations. Do not trust a username as proof of admin status; use Firebase Auth UID/claims.
3. Add server-side content moderation and enforce approved/pending visibility for **both** API and fallback reads. The API currently records pending writes if enabled; the legacy Firestore reader would not hide them.
4. Fix the current unbounded Firebase reads, and implement proper cursor pagination for posts/replies and user lookups. The preview feed currently returns only 50 posts and at most 500 replies.
5. Keep DMs private: public fallback must never expose the directMessages collection; DM endpoints must authorize conversation membership.
6. Test authenticated posting, editing/deleting, banned accounts, admin roles, CORS, rate limits, token expiry, API outage, and rollback on staging.
7. Only after those checks, switch the default frontend to the API and enforce read-only fallback for all mutations.

## VPS update (when ready for staging)
The running Webdock API was installed from an **older branch** and does not have `/v1/forum/feed` until the backend is deployed. Do not deploy the new backend or merge the frontend without a staging test. API runs via `forum-api.service`; the existing service should remain active during review.

## DM API progress (2026-10-21)
- Added `GET /v1/forum/dms` and `GET /v1/forum/dms?partner=UID` requiring a verified Firebase ID token. Both query sender/recipient by the authenticated UID and never expose unrelated messages.
- Frontend DM reads now call the authenticated API; unrestricted Firestore DM collection reads were removed. Direct DM writes have since been migrated to the API in this branch.
- Both queries are capped at 500 documents each; implement pagination before considering this a complete DM history solution.
- Deploy the matching backend and frontend **together on staging**; do not merge this draft yet. Test existing conversations, sending, banned users, offline behavior, and token expiration.
- Existing public `users` reads and admin writes still require migration; the currently published emergency Firestore rules may disable admin functionality. Never loosen DM rules to work around a broken client.

## DM write migration progress
- Frontend DM send action now calls authenticated `POST /v1/forum/dms`; direct Firestore DM write was removed from that action.
- The endpoint now calls a trusted external moderation service. Until MODERATION_URL and MODERATION_API_KEY are configured on the VPS, DM sends fail closed with HTTP 503.
- API writes remain disabled by default via `ENABLE_WRITES=false`. Do not enable writes until server moderation, security rules, and integration tests are complete.

## Moderation gateway
- `MODERATION_URL` must be an HTTPS endpoint accepting `POST` JSON `{text, category}` with `Authorization: Bearer <MODERATION_API_KEY>` and responding with JSON `{approved: true|false}`. Categories: `post`, `reply`, `dm`.
- No moderation provider is configured or deployed yet. API writes remain disabled. A real moderation service must be implemented, authenticated, tested for false positives/negatives and outages, and configured before enabling writes.
- The API rejects writes when moderation is missing, fails, times out, returns invalid JSON, or rejects the content. The endpoint URL and key are server-side secrets only.

## Additional backend safety fixes
- Account eligibility now checks the actual `banned` flag rather than treating usernames containing `ban` as banned.
- Public API reads now show approved records and legacy records without a moderation status; pending/rejected records are excluded. Firestore fallback still needs equivalent restrictions before launch.
- No live deployment or integration tests have been performed for these commits. Keep the PR in draft and `ENABLE_WRITES=false`.

## Reusing existing moderation model
- `MODERATION_PROVIDER=local-toxic-bert` uses the forum's existing `Xenova/toxic-bert` via `@huggingface/transformers@3.7.2` on the Node.js server, with the existing 0.8 non-toxic/toxic threshold logic.
- Model downloads and initialization may be slow and memory-intensive on first request. This path has NOT been integration-tested or deployed; validate the VPS RAM/CPU, cold-start latency, model cache and network availability on staging.
- When no provider is configured, writes fail closed. The optional external HTTPS moderation gateway remains supported when `MODERATION_PROVIDER` is not `local-toxic-bert`.
- `moderationConfigured` only reports configuration presence, not model readiness or successful inference. Keep `ENABLE_WRITES=false` until staging tests and complete Firestore migration.

## Release goal and acceptance criteria (2026-10-21)
**Goal:** A forum where all content/admin writes are server-authorized, server-moderated, and functional for existing accounts; private DMs remain participant-only; public reads survive a temporary API outage without permitting unmoderated writes.

- [x] API routes for posts, replies, DMs, bans/unbans, and post/reply deletes committed to draft branch
- [x] Frontend post/reply/DM sends and admin ban/unban/delete UI routed through API
- [ ] Review every remaining client Firestore write, including profile updates, username resets, account initialization, and legacy self-ban behavior; restrict rules to prevent bypass
- [ ] Add API-only profile/account update routes or strictly scoped Firestore rules with server-owned ban/admin fields
- [ ] Replace username-based admin UI checks with UID-based authorization; verify admin listing/search privacy
- [ ] Audit and test HTML rendering against XSS, especially user-generated names, posts, and moderation search results
- [ ] Confirm API feed and safe Firestore read-only fallback behave consistently with moderation states
- [ ] Test cold-start toxic-bert on staging VPS, moderation false positives, CPU/RAM, timeouts and failure mode
- [ ] Add automated endpoint tests for auth, authorization, DMs, moderation, rate limits, and error handling
- [ ] Verify legacy data compatibility and DM pagination; verify Firebase security rules in emulator
- [ ] Deploy backend first in read-only mode, smoke-test, stage frontend, then enable writes only after checks pass
- [ ] Merge only after smoke tests and rollback plan. No production changes have been made by these GitHub commits.

**Critical:** Current branch frontend is NOT safe to deploy against the old read-only API. Keep PR draft and `ENABLE_WRITES=false`.

## Review findings requiring fixes before release
- The original account creation stores `username`, `email`, `uid`, and `backupname` directly in `users`; the staged `firestore.rules.candidate` deliberately does not accept this legacy shape. Account creation/profile storage must be migrated and tested before those rules can be published.
- The frontend's public user listing currently reads complete `users` documents; separate public profile fields from private account data before enabling stricter privacy rules.
- `forumApiPreview=1` is read-only; the current draft frontend's write paths require a newly deployed API with `ENABLE_WRITES=true`. Do not deploy frontend independently.
- The browser still performs some client-side moderation and username resets. Move moderation policy decisions to the API, and avoid direct client mutations of security fields.
- New `/v1/forum/me` returns server-calculated admin permission; `ADMIN_UIDS` must be configured with trusted Firebase UIDs, never display names.
- Model integration and endpoints have NOT been run in CI or on the VPS. Run `npm install`, `npm run check`, emulator tests and smoke tests in staging first. This document is not evidence that any test passed.

## Additional implementation status
- [x] Profile creation, username changes, username reset and avatar/bio edits now call authenticated `POST /v1/forum/me/profile` in the draft frontend.
- [x] Audit found zero remaining direct `addDoc`, `setDoc`, `updateDoc`, or `deleteDoc` calls in `index.html` at this revision.
- [x] Candidate Firestore rules now deny all client writes to posts, replies, DMs and user profiles; **not published**.
- [x] CI workflow added for Node backend and inline frontend JavaScript syntax; **checks not yet confirmed passing**.
- [ ] Username uniqueness currently uses a read-before-write scan and is **not concurrency-safe**; replace with an atomic username claim/transaction before release.
- [ ] Existing public `users` reads can expose email/other private profile fields; migrate public profile reads to API projections and tighten rules.
- [ ] Verify remaining unsafe HTML interpolation, legacy admin UI and account lifecycle; run Firebase emulator tests.
- [ ] Confirm API-first frontend behavior under outage. Public feed may fall back read-only; all writes must fail closed.
- [ ] Stage, test, configure `ADMIN_UIDS`, deploy backend and frontend in a controlled release.

## Latest verified checks (static only)
- Parsed the current `api/server.js` JavaScript with a JS syntax parser successfully (not a runtime/integration test).
- Scanned current `index.html` for direct Firestore `addDoc`, `setDoc`, `updateDoc`, `deleteDoc` calls: none found.
- Admin user list now uses authenticated `GET /v1/forum/admin/users`, projecting username/ban/badges and omitting email; limited to 500 users until pagination is implemented.
- Username claims are transactional for new API writes; existing usernames are checked against legacy user documents. Legacy claim migration and simultaneous registration tests remain required.
- Remaining public user document reads mean privacy is **not yet fixed**. Publishing candidate rules now would still expose legacy user email fields to public readers. Migrate profile reads to safe API projections and restrict client rules before production release.
- No VPS access or Firebase emulator was used in these checks. Deployment remains blocked.

## Profile privacy milestone (2026-10-21)
- [x] Added `GET /v1/forum/profiles/:uid` with public-only fields and no email or ban reason.
- [x] Added `GET /v1/forum/username/:name` supporting username claims and legacy accounts.
- [x] Switched frontend username checks, username lookup, public profile popup, post author details and DM display names to those API endpoints.
- [ ] Remaining direct `users` reads in the frontend still include authenticated self/account state and DM permission checks; replace with appropriately scoped `/me` data before tightening Firestore reads.
- [ ] Candidate Firestore rules currently allow public reads of full `users` documents; **do not publish** until all frontend consumers are migrated and profile visibility rules are redesigned.
- [ ] Add emulator-backed integration tests and measure performance: the legacy username lookup currently scans all user documents.
- [ ] Verify the new profile endpoints and frontend syntax in CI, then stage and smoke-test; no production deployment yet.

## Goal: safe API-only release
**Release acceptance criteria:** (1) no direct client reads/writes of private `users` docs; (2) all client writes mediated by verified Firebase Auth API; (3) no publicly readable DMs; (4) no unreviewed content bypasses moderation; (5) emulator integration and browser smoke tests pass; (6) API deployment verified before switching frontend; (7) rollback documented and exercised.

Progress: Draft frontend now has zero `getDoc(` calls and no direct Firestore writes. Remaining `getDocs(` calls read public posts/replies and legacy `devmsg`; review `devmsg` compatibility. Candidate rules now deny all client reads/writes to `users`, but **must not be published yet**. Posting preview and API error interpolations were escaped to reduce XSS risk.

**Deployment hold:** The draft frontend expects new API endpoints absent from the currently deployed backend. `ENABLE_WRITES=false` is intentional. Do not merge, flip this switch, or publish the candidate rules until emulator/browser tests and staged deployment are complete.

## Automated test status
- GitHub Actions run for commit `d14c987e6f92ac34eb7c80eaa9a4a49539612a5b` completed **successfully**. It runs Node syntax checks and seven static security-contract checks.
- These are not Firebase emulator, browser, model-inference or real-user integration tests.
- A non-destructive read-only staging smoke script is now available: `FORUM_STAGING_API=https://your-staging-api.example node api/test/staging-smoke.js`. It verifies health, feed, unauthenticated endpoint denial and writes-disabled status. Do not point it at production without understanding the expected configuration; it intentionally requires writes disabled.
- Next: prepare isolated staging credentials, Firebase emulator rules tests, browser DM/account smoke tests and moderation-model load testing. Keep live `ENABLE_WRITES=false`.
