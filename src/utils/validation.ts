import { UserNode } from "../model/user";
import { Timings } from "../model/timings";
import {
  DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
  DEFAULT_TIME_BETWEEN_UNFOLLOWS,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
  DEFAULT_USERS_PER_SEARCH_CYCLE,
  TIMING_LIMITS,
} from "../constants/constants";

/**
 * Everything read back from localStorage or an imported file is untrusted: it
 * can be corrupted, edited by hand, or written by another script on the page.
 * These helpers turn it into well-formed data or drop it, so it can never
 * reach a URL path (unfollow endpoint), an href, or an <img src> unchecked.
 */

const NUMERIC_ID = /^\d{1,20}$/;
// Ids of entries created by "Paste usernames" in the whitelist manager.
const SYNTHETIC_ID = /^pasted_[A-Za-z0-9._]{1,30}(?:_[A-Za-z0-9]+)*$/;
// Instagram usernames: letters, digits, dots, underscores, max 30.
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export function isValidInstagramId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID.test(value);
}

export function isValidUsername(value: unknown): value is string {
  return typeof value === "string" && USERNAME.test(value);
}

/** Only https image URLs are accepted; anything else becomes "" (a local placeholder is shown). */
export function sanitizeImageUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    return "";
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function toBool(value: unknown): boolean {
  return value === true;
}

/**
 * Returns a clean UserNode, or null if the entry is not a plausible account.
 * `allowSynthetic` additionally accepts the ids the whitelist paste feature
 * generates; scan results and the unfollow queue only ever accept real numeric ids.
 */
export function sanitizeUserNode(raw: unknown, allowSynthetic: boolean = false): UserNode | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const idOk = isValidInstagramId(r.id) || (allowSynthetic && typeof r.id === "string" && SYNTHETIC_ID.test(r.id));
  if (!idOk || !isValidUsername(r.username)) {
    return null;
  }
  const fullName = typeof r.full_name === "string" ? r.full_name.slice(0, 150) : "";
  // Entries made by "Paste usernames" have no real picture. Older versions stored a third-party
  // avatar URL for them; drop it so no username is ever sent to that service.
  const isSynthetic = typeof r.id === "string" && !NUMERIC_ID.test(r.id);
  return {
    id: r.id as string,
    username: r.username,
    full_name: fullName,
    profile_pic_url: isSynthetic ? "" : sanitizeImageUrl(r.profile_pic_url),
    is_private: toBool(r.is_private),
    is_verified: toBool(r.is_verified),
    followed_by_viewer: true,
    follows_viewer: toBool(r.follows_viewer),
    requested_by_viewer: false,
  };
}

export function sanitizeUserList(raw: unknown, allowSynthetic: boolean = false): UserNode[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const users: UserNode[] = [];
  for (const entry of raw) {
    const user = sanitizeUserNode(entry, allowSynthetic);
    if (user !== null && !seen.has(user.id)) {
      seen.add(user.id);
      users.push(user);
    }
  }
  return users;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Pacing values come from localStorage and from the settings form. A zero or
 * negative delay would hammer Instagram and get the account throttled, so
 * every value is forced back into the same range the settings form enforces.
 */
export function clampTimings(timings: Timings): Timings {
  const L = TIMING_LIMITS;
  return {
    timeBetweenSearchCycles: clamp(timings.timeBetweenSearchCycles, L.timeBetweenSearchCycles.min, L.timeBetweenSearchCycles.max, DEFAULT_TIME_BETWEEN_SEARCH_CYCLES),
    timeToWaitAfterFiveSearchCycles: clamp(timings.timeToWaitAfterFiveSearchCycles, L.timeToWaitAfterFiveSearchCycles.min, L.timeToWaitAfterFiveSearchCycles.max, DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES),
    timeBetweenUnfollows: clamp(timings.timeBetweenUnfollows, L.timeBetweenUnfollows.min, L.timeBetweenUnfollows.max, DEFAULT_TIME_BETWEEN_UNFOLLOWS),
    timeToWaitAfterFiveUnfollows: clamp(timings.timeToWaitAfterFiveUnfollows, L.timeToWaitAfterFiveUnfollows.min, L.timeToWaitAfterFiveUnfollows.max, DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS),
    usersPerSearchCycle: clamp(timings.usersPerSearchCycle, L.usersPerSearchCycle.min, L.usersPerSearchCycle.max, DEFAULT_USERS_PER_SEARCH_CYCLE),
  };
}

/** Case-insensitive username set used to match whitelist entries that have no real id. */
export function lowerUsername(user: { readonly username: string }): string {
  return user.username.toLowerCase();
}
