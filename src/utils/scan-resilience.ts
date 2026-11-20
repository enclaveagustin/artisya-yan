import {
  MAX_CONSECUTIVE_EMPTY_PAGES,
  RATE_LIMIT_BACKOFF_BASE_SECONDS,
  RATE_LIMIT_BACKOFF_MAX_SECONDS,
  NETWORK_BACKOFF_BASE_SECONDS,
} from "../constants/constants";

/**
 * Pure helpers that make the scan resumable and the retry policy testable.
 * Nothing here touches the DOM, localStorage or the network.
 */

export type ErrorKind = "rate-limit" | "network" | "server" | "fatal";

export interface ErrorLike {
  readonly status?: number;
  readonly message?: string;
  readonly name?: string;
  readonly notJson?: boolean;
  readonly retryAfterSeconds?: number;
}

/**
 * Decides how a failed request should be handled.
 *  - rate-limit: 429, Instagram's HTML soft-throttle page, feedback_required, checkpoint
 *  - server:     5xx, retried like a network blip
 *  - network:    fetch itself failed (offline, DNS, aborted)
 *  - fatal:      4xx that will not get better by waiting (404, 400 on a bad id, ...)
 */
export function classifyError(error: unknown): ErrorKind {
  const e = (error ?? {}) as ErrorLike;
  const message = String(e.message ?? "");
  const isApiError = e.name === "InstagramApiError";

  if (isApiError) {
    if (
      e.status === 429 ||
      e.notJson === true ||
      /feedback_required|checkpoint|rate limit|please wait|try again later/i.test(message)
    ) {
      return "rate-limit";
    }
    if (typeof e.status === "number" && e.status >= 500) {
      return "server";
    }
    return "fatal";
  }
  if (error instanceof TypeError || /fetch|network|failed to load/i.test(message)) {
    return "network";
  }
  return "fatal";
}

/**
 * Exponential backoff with jitter, capped. `attempt` starts at 1. A Retry-After
 * value from Instagram wins when it is longer than our own estimate.
 */
export function computeBackoffSeconds(
  attempt: number,
  kind: ErrorKind,
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number {
  const base = kind === "rate-limit" ? RATE_LIMIT_BACKOFF_BASE_SECONDS : NETWORK_BACKOFF_BASE_SECONDS;
  const max = kind === "rate-limit" ? RATE_LIMIT_BACKOFF_MAX_SECONDS : 60;
  const exponential = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jittered = exponential * (0.85 + random() * 0.3);
  const wait = Math.max(jittered, retryAfterSeconds ?? 0);
  return Math.ceil(Math.min(wait, RATE_LIMIT_BACKOFF_MAX_SECONDS * 2));
}

/**
 * Adaptive request pacing: every throttling event slows the remaining scan
 * down, clean pages slowly speed it back up. Returns the new multiplier.
 */
export function adjustPaceMultiplier(current: number, event: "throttled" | "clean-page"): number {
  if (event === "throttled") {
    return Math.min(4, current * 1.5);
  }
  return Math.max(1, current - 0.1);
}

/** Where a paginated walk stands. Mutated in place so a failed scan can resume. */
export interface ListCursor {
  maxId?: string;
  pagesFetched: number;
  emptyPages: number;
  done: boolean;
}

export function createListCursor(): ListCursor {
  return { maxId: undefined, pagesFetched: 0, emptyPages: 0, done: false };
}

export interface PageLike<U> {
  readonly users?: readonly U[];
  readonly next_max_id?: string;
  readonly has_more?: boolean;
}

export type PageFetch<U> =
  | { readonly ok: true; readonly page: PageLike<U> }
  | { readonly ok: false; readonly blocked: boolean };

export type WalkStopReason =
  | "completed"
  | "fetch-failed"
  | "stopped-by-consumer"
  | "safety-limit"
  | "stuck-cursor"
  | "empty-pages";

export interface WalkResult {
  readonly completed: boolean;
  readonly reason: WalkStopReason;
}

/**
 * Walks a cursor-paginated list. The cursor only advances AFTER a page has been
 * handed to `onPage`, so when a fetch fails the same page is requested again on
 * resume and nothing is skipped or counted twice.
 *
 * A list only counts as completed when Instagram says there is nothing more
 * (no next cursor, or has_more === false). Anything else - failures, a stuck
 * cursor, a run of empty pages, the safety cap - is reported as incomplete so
 * callers never present a partial list as a full one.
 */
export async function walkList<U>(options: {
  readonly cursor: ListCursor;
  readonly pageSafetyLimit: number;
  readonly fetchPage: (maxId: string | undefined) => Promise<PageFetch<U>>;
  readonly onPage: (users: readonly U[]) => boolean | Promise<boolean>;
  readonly pace: () => Promise<void>;
}): Promise<WalkResult> {
  const { cursor, pageSafetyLimit, fetchPage, onPage, pace } = options;
  if (cursor.done) {
    return { completed: true, reason: "completed" };
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const result = await fetchPage(cursor.maxId);
    if (!result.ok) {
      return { completed: false, reason: "fetch-failed" };
    }
    const users = result.page.users ?? [];
    if (!(await onPage(users))) {
      return { completed: false, reason: "stopped-by-consumer" };
    }

    const nextMaxId = result.page.next_max_id;
    const hasMore = Boolean(nextMaxId) && result.page.has_more !== false;
    if (!hasMore) {
      cursor.done = true;
      return { completed: true, reason: "completed" };
    }
    if (nextMaxId === cursor.maxId) {
      // Instagram handed back the cursor we just sent: the walk would loop forever.
      return { completed: false, reason: "stuck-cursor" };
    }

    cursor.maxId = nextMaxId;
    cursor.pagesFetched += 1;
    cursor.emptyPages = users.length === 0 ? cursor.emptyPages + 1 : 0;

    if (cursor.emptyPages > MAX_CONSECUTIVE_EMPTY_PAGES) {
      return { completed: false, reason: "empty-pages" };
    }
    if (cursor.pagesFetched >= pageSafetyLimit) {
      return { completed: false, reason: "safety-limit" };
    }
    await pace();
  }
}
