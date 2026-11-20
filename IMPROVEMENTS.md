# Artisya Yan?! — Reliability & Security Improvement Plan

> **Status:** Phase 1 and Phase 2 are implemented and verified (typecheck, lint, 17 unit tests, an end-to-end
> run of the built bundle against a simulated throttled Instagram, `npm audit` = 0 production vulnerabilities).
> Phase 3 is the roadmap.

## 1. The failure you hit

> ⚠️ *Incomplete scan: it was interrupted before every account was checked, so some non-followers may be missing.
> Mass unfollow is disabled to protect your account.*

That banner is **not a crash**. It is the app's safety lock. The scan walks your *followers* list, then your
*following* list, page by page. If any page cannot be fetched, the scan stops and the lock engages, because acting
on a partial list could unfollow people who do follow you back.

### Why pages failed (root causes, in order of likelihood)

| # | Cause | What the old code did |
|---|-------|-----------------------|
| 1 | **Instagram throttled the scan** (HTTP 429, the HTML "soft block" page, `feedback_required`). Long lists trigger this after a few thousand accounts. | Retried only **3 times** with 30 / 60 / 90 s waits (~3 min total), then gave up. Throttles routinely last longer. |
| 2 | **Transient server/network errors** (HTTP 5xx, dropped connection). | 5xx was treated as *fatal*: no retry at all. |
| 3 | **Giving up lost all progress.** | There was no way to continue. The only option was a brand-new scan, which re-downloads every follower and walks straight back into the same throttle. |
| 4 | **Unexpected exception** inside the scan. | Re-thrown as an unhandled rejection, leaving the UI stuck on "scanning" forever. |
| 5 | **Cursor oddities** (same cursor returned twice, empty page that still has a cursor). | An empty page with a cursor was treated as "end of list", which could silently produce an incomplete list that *looked* complete. |

## 2. Phase 1 — Make the scan unable to fail "for good" (implemented)

| Fix | Where | Effect |
|-----|-------|--------|
| **Resume scan** button | `main.tsx`, `Searching.tsx` | A failed scan keeps a checkpoint (follower index, both cursors, results). Resume restarts at the **exact page that failed**. Nothing is re-downloaded or double-counted. |
| **Resumable list walker** `walkList` | `utils/scan-resilience.ts` | The cursor only advances *after* a page is processed. A list counts as finished only when Instagram says so; a stuck cursor, a run of empty pages, or the safety cap are reported as *incomplete*, never as done. |
| **Longer, smarter retries** | `scan-resilience.ts`, `constants.ts` | 6 retries (was 3), exponential backoff 30 s → 60 → 120 → 240 → 300 s with ±15 % jitter, honours Instagram's `Retry-After`. 5xx and network errors are retried. |
| **Adaptive pacing** | `main.tsx` | Each throttle slows all following requests (×1.5, up to ×4); clean pages speed it back up. The scan self-tunes instead of hammering. |
| **Crash safety** | `main.tsx` | Any unexpected exception ends as an *incomplete* scan with Resume available, instead of freezing. |
| **Single-scan guard** | `main.tsx` | A stray re-render can never start a second concurrent walk. |
| **Cooldown respected** | `main.tsx` | After retries are exhausted the persisted 10-minute cooldown applies; Resume tells you how long is left instead of poking Instagram again. |

**How to use it:** if you see the banner, wait for the cooldown, press **Resume scan**. Do not start a new scan.

## 3. Phase 2 — Safety & security hardening (implemented)

| Risk | Fix |
|------|-----|
| **Whitelist did not protect pasted usernames.** Entries from "Paste usernames" got a fake id, but protection matched by id only, so those accounts were still offered for unfollow. | Whitelist now matches by id **or** username (case-insensitive), everywhere (display, select, merge, remove). |
| **No last line of defence in the unfollow queue.** | The queue re-checks the whitelist itself and skips protected accounts and anything without a numeric id. |
| **Path injection:** an account id from tampered localStorage / an imported file went straight into the request URL (`/friendships/destroy/<id>/`). | `isValidInstagramId` (digits only) is enforced on load, on import, on the viewer id cookie, and again right before the request. |
| **Open redirect / link injection:** a username like `//evil.com` became `href="//evil.com"`. | Usernames validated (`[A-Za-z0-9._]{1,30}`) and `encodeURIComponent`-ed in links. |
| **Untrusted storage & imports** (whitelist file, cached scan, timings). | Everything read back is rebuilt from known-safe fields (`sanitizeUserNode`); junk is dropped; imports capped at 5 MB; non-`https` image URLs rejected. |
| **Stale list unfollows people who followed back.** | A cached scan older than 24 h is not offered. Only **complete** scans are cached, so a partial result can never reload looking finished. |
| **Dangerous timings** (0 ms delays from edited storage) → rate-limits/ban. | `clampTimings` forces every value into the same range the settings form enforces, on load and on save. |
| **Privacy leak:** pasted whitelist usernames and preview avatars were sent to `api.dicebear.com`. | Avatars are drawn locally (inline SVG). `referrerpolicy="no-referrer"` on images. No third-party requests are made by the app. |
| **Account switched mid-run** would unfollow with the wrong session. | Unfollow aborts if `ds_user_id` changes; the scan already did. |
| **Broken endpoint hammering.** | Unfollow stops after 3 consecutive failures; expired session tokens are re-read. |
| **Vulnerable dependencies** (36 advisories incl. 3 critical: webpack, webpack-dev-server, ws, websocket-driver…). | Updated; unused Babel toolchain removed. **Production deps: 0 vulnerabilities.** Remaining 13 are one dev-only picomatch ReDoS advisory with no patched release (affects only build-time globbing). |
| **EOL Node 16** pinned in `.nvmrc`/CI. | Node 22, `engines >= 20`, `npm ci` (lockfile-exact installs). |
| **CI**: `npm install`, broad token scope. | `npm ci`, least-privilege `permissions`, typecheck + lint + tests + `npm audit` gate the deploy; PRs cannot hand-edit the generated `docs/index.html`. |
| **Lint config was stale** (383 noise errors, no security rules). | New focused ESLint config: bans `eval`, `new Function`, `javascript:` URLs, `document.write`, `dangerouslySetInnerHTML`. |

## 4. Phase 3 — Roadmap (not done yet)

1. **Persist the checkpoint** (sessionStorage) so Resume also survives closing the tab.
2. **Optional "unfollow verified non-followers only" on partial scans.** Safe in principle (the follower index is complete when only the *following* walk failed) but kept off by default.
3. **Re-verify each account right before unfollowing** (one cheap lookup) to catch follow-backs since the scan.
4. **Dry-run mode** that lists exactly what would be unfollowed and writes a CSV audit log before any action.
5. **Daily unfollow budget** (default ≤ 100/day) with a visible counter.
6. **Detect endpoint drift** (`X-ASBD-ID`, GraphQL doc ids) with a self-test on startup and a clear "Instagram changed, update available" message instead of a generic failure.
7. **Split `main.tsx`** into `useScan` / `useUnfollow` hooks and add component tests.
8. ~~Self-host the page fonts and highlighter~~ **Done in 1.4.0** (the copy page makes zero external requests). Still open: a Content-Security-Policy with a build-time script hash.
9. **Pin GitHub Actions to commit SHAs** and enable Dependabot.

## 5. Operating guide — how to keep it from failing

* Keep the default delays. Lowering them is the main way people get throttled.
* Do not run it from several tabs/devices at once on the same account.
* If throttled: let it back off automatically, then **Resume scan** after the cooldown. Never mash "Run Scan".
* Unfollow in small batches (≈ 50–100 per day). The queue stops itself on an action block.
* Whitelist accounts you care about first; protection is enforced twice (UI and queue).
* The code is only safe if it is the code you built. Use the page from **your** GitHub Pages site, not a copy from someone else.

## 6. Verification performed

* `npm run typecheck` — clean
* `npm run lint` — clean
* `npm test` — 17/17 (walk/resume, backoff, error classification, validation, whitelist matching)
* End-to-end (built `dist.js` in a simulated Instagram): throttle on following page 2 ×7 → scan stops *incomplete*, unfollow locked, Resume offered → refused during cooldown → after cooldown resumes at `following:2`, **followers not re-downloaded**, final result = exactly the 6 true non-followers, cached, unfollow unlocked.
* `npm audit --omit=dev` — 0 vulnerabilities

> **Not verified:** behaviour against the real Instagram, which changes its private API without notice. Expect to
> revisit `INSTAGRAM_ASBD_ID` / headers occasionally (see `src/constants/constants.ts`).
