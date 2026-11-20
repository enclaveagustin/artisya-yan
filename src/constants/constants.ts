export const INSTAGRAM_HOSTNAME = "www.instagram.com";
export const UNFOLLOWERS_PER_PAGE = 50;

// The app id Instagram's own web frontend sends on its private REST API
// calls (e.g. /api/v1/friendships/<id>/following/). Required or these
// endpoints behave inconsistently; it is not a secret, just an identifier
// for "the instagram.com web client" and is safe to keep public.
export const INSTAGRAM_WEB_APP_ID = "936619743392459";
// Changed from "129477" to "359341" in Oct 2026: with the old value the
// friendships endpoints answer with the HTML page instead of JSON. If scans
// start failing with "Unexpected token '<'" again, read the X-ASBD-ID header
// Instagram's own followers request sends in DevTools and update it here.
export const INSTAGRAM_ASBD_ID = "359341";

// The persisted GraphQL query instagram.com's own Unfollow button runs
// (fb_api_req_friendly_name "usePolarisUnfollowMutation"). Instagram can rotate
// this id on a deploy; if unfollows start failing with a GraphQL error, capture
// the button's /api/graphql request in DevTools and update it here.
export const INSTAGRAM_UNFOLLOW_DOC_ID = "27789106940691111";
export const INSTAGRAM_UNFOLLOW_FRIENDLY_NAME = "usePolarisUnfollowMutation";

// Page-count safety cap for loading the viewer's own following and followers lists
// (see utils/utils.ts and main.tsx). Instagram returns ~25 users per page no
// matter what `count` asks for, so 250 pages stopped at ~5,700 accounts. The cap
// only guards against an endless walk (a stuck cursor is caught separately in
// main.tsx), so it sits far above any real list: following tops out at 7,500.
export const FOLLOWING_PAGE_SAFETY_LIMIT = 2000;
export const FOLLOWERS_PAGE_SAFETY_LIMIT = 2000;
// A long safety sleep is taken once every this many scan requests.
export const CHECKS_BEFORE_LONG_SLEEP = 15;
export const RATE_LIMIT_COOLDOWN_SECONDS = 30;
// How often a waiting scan checks whether Pause / Resume was pressed.
export const PAUSE_POLL_MS = 250;

// --- Scan resilience -------------------------------------------------------
// How many times one page request is retried before the scan stops (it can then
// be resumed from the same page with the "Resume scan" button).
export const MAX_SCAN_RETRIES = 6;
// A list request that has not started answering after this long is abandoned and retried.
export const REQUEST_TIMEOUT_MS = 30000;
// Exponential backoff (with jitter): 30s, 60s, 120s, 240s, 300s, 300s ...
export const RATE_LIMIT_BACKOFF_BASE_SECONDS = 30;
export const RATE_LIMIT_BACKOFF_MAX_SECONDS = 300;
export const NETWORK_BACKOFF_BASE_SECONDS = 5;
// An empty page that still carries a next cursor is tolerated this many times
// in a row; beyond that the scan is reported as incomplete instead of guessing.
export const MAX_CONSECUTIVE_EMPTY_PAGES = 3;
// A cached scan older than this is not offered/loaded: people follow back, so
// unfollowing from a stale list would remove accounts that now follow you.
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Allowed range of every pacing setting. The settings form and anything read
// back from localStorage are forced into these ranges.
export const TIMING_LIMITS = {
  timeBetweenSearchCycles: { min: 500, max: 999999 },
  timeToWaitAfterFiveSearchCycles: { min: 4000, max: 999999 },
  timeBetweenUnfollows: { min: 1000, max: 999999 },
  timeToWaitAfterFiveUnfollows: { min: 70000, max: 999999 },
  usersPerSearchCycle: { min: 1, max: 200 },
} as const;
export const WHITELISTED_RESULTS_STORAGE_KEY = "iu_whitelisted-results";
export const TIMINGS_STORAGE_KEY = "iu_timings";
export const LAST_SCAN_RESULTS_STORAGE_KEY = "iu_last-scan-results";
export const LAST_SCAN_TIMESTAMP_STORAGE_KEY = "iu_last-scan-time";
// Persisted across reloads: starting a scan/unfollow before this is refused.
export const BLOCKED_UNTIL_STORAGE_KEY = "iu_blocked_until";
// In-progress scan saved so it survives a reload / discarded tab.
export const SCAN_CHECKPOINT_STORAGE_KEY = "iu_scan-checkpoint";
// A saved partial scan older than this is dropped: the follower list has moved on.
export const SCAN_CHECKPOINT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// The checkpoint is written every this many pages (and whenever the tab is hidden).
export const SCAN_CHECKPOINT_SAVE_EVERY_PAGES = 5;
export const BLOCKED_COOLDOWN_MS = 10 * 60 * 1000;

//TIMINGS CONSTANTS
export const DEFAULT_TIME_BETWEEN_SEARCH_CYCLES = 1000;
export const DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES = 10000;
export const DEFAULT_TIME_BETWEEN_UNFOLLOWS = 4000;
export const DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS = 300000;
export const DEFAULT_USERS_PER_SEARCH_CYCLE = 50;

// FILTER CONSTANTS
export const WITHOUT_PROFILE_PICTURE_URL_IDS = [
  "44884218_345707102882519_2446069589734326272_n",
  "464760996_1254146839119862_3605321457742435801_n",
];
