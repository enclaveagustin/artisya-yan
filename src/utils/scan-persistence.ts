import { UserNode } from "../model/user";
import {
  SCAN_CHECKPOINT_MAX_AGE_MS,
  SCAN_CHECKPOINT_STORAGE_KEY,
} from "../constants/constants";
import { createListCursor, ListCursor } from "./scan-resilience";
import { createFollowerIndex } from "./utils";
import { isValidInstagramId, sanitizeUserList } from "./validation";

/**
 * Persistence for an in-progress scan, so a reload (a discarded background tab,
 * a crash, an accidental refresh) does not throw away minutes of work.
 *
 * The serialize/deserialize pair is pure and testable; the load/save/clear
 * wrappers around it are the only code that touches localStorage. Everything
 * read back is untrusted and is rebuilt field by field.
 */

// Everything an interrupted scan needs to continue instead of starting over.
//
// The scan runs in two passes so results show up immediately:
//   1. following: every account you follow becomes a *candidate* and is listed at once;
//   2. followers: whoever turns out to follow you back is removed from the candidates.
// Candidates are only final once the followers pass has completed.
export interface ScanCheckpoint {
  readonly viewerId: string;
  readonly followerIndex: ReturnType<typeof createFollowerIndex>;
  followersCount: number;
  readonly followersCursor: ListCursor;
  readonly followingCursor: ListCursor;
  followingCount: number;
  candidates: UserNode[];
  readonly seenFollowingIds: Set<string>;
}

export const createScanCheckpoint = (viewerId: string): ScanCheckpoint => ({
  viewerId,
  followerIndex: createFollowerIndex(),
  followersCount: 0,
  followersCursor: createListCursor(),
  followingCursor: createListCursor(),
  followingCount: 0,
  candidates: [],
  seenFollowingIds: new Set<string>(),
});

// Progress is an estimate (the totals are not known up front): it climbs
// quickly at first and flattens out, never reaching the end of its range.
const phaseFill = (count: number): number => 1 - 1 / (1 + count / 150);

/** Following pass fills 0-49%. */
export const followingPhasePercentage = (followingCount: number): number =>
  Math.min(49, Math.round(50 * phaseFill(followingCount)));

/** Followers pass fills 50-99%. Never 100: that is reserved for a finished scan. */
export const followersPhasePercentage = (followersCount: number): number =>
  Math.min(99, 50 + Math.round(50 * phaseFill(followersCount)));

export function checkpointPercentage(checkpoint: ScanCheckpoint): number {
  return checkpoint.followingCursor.done
    ? followersPhasePercentage(checkpoint.followersCount)
    : followingPhasePercentage(checkpoint.followingCount);
}

const STORAGE_VERSION = 2;
const MAX_INDEX_ENTRIES = 200000;
const MAX_INDEX_STRING = 64;

interface SerializedCheckpoint {
  readonly v: number;
  readonly savedAt: number;
  readonly viewerId: string;
  readonly followerIds: readonly string[];
  readonly followerUsernames: readonly string[];
  readonly followersCount: number;
  readonly followersCursor: ListCursor;
  readonly followingCursor: ListCursor;
  readonly followingCount: number;
  readonly candidates: readonly UserNode[];
}

export function serializeCheckpoint(checkpoint: ScanCheckpoint, now: number = Date.now()): string {
  const payload: SerializedCheckpoint = {
    v: STORAGE_VERSION,
    savedAt: now,
    viewerId: checkpoint.viewerId,
    followerIds: Array.from(checkpoint.followerIndex.ids),
    followerUsernames: Array.from(checkpoint.followerIndex.usernames),
    followersCount: checkpoint.followersCount,
    followersCursor: checkpoint.followersCursor,
    followingCursor: checkpoint.followingCursor,
    followingCount: checkpoint.followingCount,
    // Avatar URLs are long and would roughly triple the stored size; a resumed
    // scan shows the local placeholder for them instead.
    candidates: checkpoint.candidates.map(user => ({ ...user, profile_pic_url: "" })),
  };
  return JSON.stringify(payload);
}

const toCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;

function parseCursor(value: unknown): ListCursor | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const r = value as Record<string, unknown>;
  const pagesFetched = toCount(r.pagesFetched);
  const emptyPages = toCount(r.emptyPages);
  const maxIdOk = r.maxId === undefined || (typeof r.maxId === "string" && r.maxId.length > 0 && r.maxId.length <= 512);
  if (pagesFetched === null || emptyPages === null || !maxIdOk || typeof r.done !== "boolean") {
    return null;
  }
  return { maxId: r.maxId as string | undefined, pagesFetched, emptyPages, done: r.done };
}

/**
 * Rebuilds a checkpoint from stored text, or returns null when it is missing,
 * malformed, for another account, or too old to trust (people follow back).
 */
export function deserializeCheckpoint(
  raw: string | null,
  expectedViewerId: string,
  now: number = Date.now(),
): { readonly checkpoint: ScanCheckpoint; readonly savedAt: number } | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const r = parsed as Record<string, unknown>;
    if (r.v !== STORAGE_VERSION || r.viewerId !== expectedViewerId || !isValidInstagramId(r.viewerId)) {
      return null;
    }
    const savedAt = r.savedAt;
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt > now + 60_000 || now - savedAt > SCAN_CHECKPOINT_MAX_AGE_MS) {
      return null;
    }
    const followersCount = toCount(r.followersCount);
    const followingCount = toCount(r.followingCount);
    const followersCursor = parseCursor(r.followersCursor);
    const followingCursor = parseCursor(r.followingCursor);
    if (followersCount === null || followingCount === null || followersCursor === null || followingCursor === null) {
      return null;
    }
    // The followers pass can only have started once the following list was fully loaded.
    if (!followingCursor.done && (followersCursor.pagesFetched > 0 || followersCount > 0)) {
      return null;
    }
    if (!Array.isArray(r.followerIds) || !Array.isArray(r.followerUsernames)) {
      return null;
    }
    if (r.followerIds.length > MAX_INDEX_ENTRIES || r.followerUsernames.length > MAX_INDEX_ENTRIES) {
      return null;
    }

    const followerIndex = createFollowerIndex();
    // These strings are only ever used for set membership (never in a URL or
    // markup), so a length bound is enough. A single bad entry rejects the whole
    // checkpoint: an index that lost entries would flag real followers as
    // non-followers.
    for (const id of r.followerIds) {
      if (typeof id !== "string" || id.length === 0 || id.length > MAX_INDEX_STRING) {
        return null;
      }
      followerIndex.ids.add(id);
    }
    for (const name of r.followerUsernames) {
      if (typeof name !== "string" || name.length === 0 || name.length > MAX_INDEX_STRING) {
        return null;
      }
      followerIndex.usernames.add(name);
    }
    if (followersCount > 0 && followerIndex.ids.size === 0 && followerIndex.usernames.size === 0) {
      return null;
    }

    if (!Array.isArray(r.candidates) || r.candidates.length > MAX_INDEX_ENTRIES) {
      return null;
    }
    const candidates = sanitizeUserList(r.candidates).filter(user => !user.follows_viewer);
    // While the following list is still loading nothing has been removed yet, so
    // losing an entry means the saved list is damaged and must not be trusted.
    if (!followingCursor.done && candidates.length !== r.candidates.length) {
      return null;
    }
    return {
      savedAt,
      checkpoint: {
        viewerId: expectedViewerId,
        followerIndex,
        followersCount,
        followersCursor,
        followingCursor,
        followingCount,
        candidates,
        seenFollowingIds: new Set(candidates.map(user => user.id)),
      },
    };
  } catch {
    return null;
  }
}

const storageKey = (viewerId: string): string => `${SCAN_CHECKPOINT_STORAGE_KEY}-${viewerId}`;

export function saveScanCheckpoint(checkpoint: ScanCheckpoint): void {
  try {
    localStorage.setItem(storageKey(checkpoint.viewerId), serializeCheckpoint(checkpoint));
  } catch (e) {
    // Quota exceeded or storage blocked: the scan still works, it just cannot be resumed after a reload.
    console.warn("Could not save scan progress:", e);
  }
}

export function loadScanCheckpoint(viewerId: string): { readonly checkpoint: ScanCheckpoint; readonly savedAt: number } | null {
  try {
    return deserializeCheckpoint(localStorage.getItem(storageKey(viewerId)), viewerId);
  } catch {
    return null;
  }
}

export function clearScanCheckpoint(viewerId: string | null): void {
  if (viewerId === null) {
    return;
  }
  try {
    localStorage.removeItem(storageKey(viewerId));
  } catch {
    // Nothing useful to do if storage is blocked.
  }
}
