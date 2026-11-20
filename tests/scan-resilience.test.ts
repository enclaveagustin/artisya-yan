import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustPaceMultiplier,
  classifyError,
  computeBackoffSeconds,
  createListCursor,
  PageFetch,
  walkList,
} from "../src/utils/scan-resilience";
import {
  clampTimings,
  isValidInstagramId,
  isValidUsername,
  sanitizeImageUrl,
  sanitizeUserList,
  sanitizeUserNode,
} from "../src/utils/validation";
import { mergeWhitelists } from "../src/utils/whitelist-manager";
import { getUsersForDisplay } from "../src/utils/utils";

const noPace = async () => undefined;

type U = { readonly id: string };
const page = (ids: string[], next?: string, hasMore?: boolean): PageFetch<U> => ({
  ok: true,
  page: { users: ids.map(id => ({ id })), next_max_id: next, has_more: hasMore },
});

// --- walkList: completeness + resume ---------------------------------------

test("walkList walks every page and only then reports completed", async () => {
  const pages: Record<string, PageFetch<U>> = {
    start: page(["1", "2"], "c1"),
    c1: page(["3", "4"], "c2"),
    c2: page(["5"], undefined),
  };
  const seen: string[] = [];
  const cursor = createListCursor();
  const result = await walkList<U>({
    cursor,
    pageSafetyLimit: 100,
    fetchPage: async maxId => pages[maxId ?? "start"],
    onPage: users => { seen.push(...users.map(u => u.id)); return true; },
    pace: noPace,
  });
  assert.equal(result.completed, true);
  assert.deepEqual(seen, ["1", "2", "3", "4", "5"]);
  assert.equal(cursor.done, true);
});

test("a failed fetch is reported incomplete and the resume re-requests the SAME page without duplicates", async () => {
  const pages: Record<string, PageFetch<U>> = {
    start: page(["1", "2"], "c1"),
    c1: page(["3", "4"], "c2"),
    c2: page(["5"], undefined),
  };
  let failC1Once = true;
  const requested: Array<string | undefined> = [];
  const seen: string[] = [];
  const cursor = createListCursor();
  const options = {
    cursor,
    pageSafetyLimit: 100,
    fetchPage: async (maxId: string | undefined): Promise<PageFetch<U>> => {
      requested.push(maxId);
      if (maxId === "c1" && failC1Once) {
        failC1Once = false;
        return { ok: false, blocked: true };
      }
      return pages[maxId ?? "start"];
    },
    onPage: (users: readonly U[]) => { seen.push(...users.map(u => u.id)); return true; },
    pace: noPace,
  };

  const first = await walkList<U>(options);
  assert.equal(first.completed, false);
  assert.equal(first.reason, "fetch-failed");
  assert.equal(cursor.maxId, "c1", "cursor must stay on the page that failed");
  assert.deepEqual(seen, ["1", "2"]);

  const second = await walkList<U>(options); // resume
  assert.equal(second.completed, true);
  assert.deepEqual(seen, ["1", "2", "3", "4", "5"], "no page skipped, none processed twice");
  assert.deepEqual(requested, [undefined, "c1", "c1", "c2"]);
});

test("a stuck cursor is incomplete, never silently treated as the end", async () => {
  const cursor = createListCursor();
  cursor.maxId = "same";
  const result = await walkList<U>({
    cursor,
    pageSafetyLimit: 100,
    fetchPage: async () => page(["1"], "same"),
    onPage: () => true,
    pace: noPace,
  });
  assert.equal(result.completed, false);
  assert.equal(result.reason, "stuck-cursor");
});

test("the page safety limit reports incomplete", async () => {
  let n = 0;
  const result = await walkList<U>({
    cursor: createListCursor(),
    pageSafetyLimit: 3,
    fetchPage: async () => page(["x"], `c${++n}`),
    onPage: () => true,
    pace: noPace,
  });
  assert.equal(result.completed, false);
  assert.equal(result.reason, "safety-limit");
});

test("a run of empty pages with a cursor is incomplete; a single empty page is tolerated", async () => {
  let n = 0;
  const infiniteEmpty = await walkList<U>({
    cursor: createListCursor(),
    pageSafetyLimit: 100,
    fetchPage: async () => page([], `c${++n}`),
    onPage: () => true,
    pace: noPace,
  });
  assert.equal(infiniteEmpty.completed, false);
  assert.equal(infiniteEmpty.reason, "empty-pages");

  const pages: Record<string, PageFetch<U>> = {
    start: page(["1"], "c1"),
    c1: page([], "c2"),
    c2: page(["2"], undefined),
  };
  const seen: string[] = [];
  const tolerated = await walkList<U>({
    cursor: createListCursor(),
    pageSafetyLimit: 100,
    fetchPage: async maxId => pages[maxId ?? "start"],
    onPage: users => { seen.push(...users.map(u => u.id)); return true; },
    pace: noPace,
  });
  assert.equal(tolerated.completed, true);
  assert.deepEqual(seen, ["1", "2"]);
});

test("has_more === false ends the list even when a cursor is present", async () => {
  const result = await walkList<U>({
    cursor: createListCursor(),
    pageSafetyLimit: 100,
    fetchPage: async () => page(["1"], "c1", false),
    onPage: () => true,
    pace: noPace,
  });
  assert.equal(result.completed, true);
});

test("walkList on an already finished cursor does no requests", async () => {
  const cursor = createListCursor();
  cursor.done = true;
  let called = false;
  const result = await walkList<U>({
    cursor,
    pageSafetyLimit: 100,
    fetchPage: async () => { called = true; return page([]); },
    onPage: () => true,
    pace: noPace,
  });
  assert.equal(result.completed, true);
  assert.equal(called, false);
});

// --- retry policy ----------------------------------------------------------

test("classifyError separates throttling, network, server and fatal errors", () => {
  assert.equal(classifyError({ name: "InstagramApiError", status: 429, message: "" }), "rate-limit");
  assert.equal(classifyError({ name: "InstagramApiError", status: 200, notJson: true, message: "" }), "rate-limit");
  assert.equal(classifyError({ name: "InstagramApiError", status: 400, message: "feedback_required" }), "rate-limit");
  assert.equal(classifyError({ name: "InstagramApiError", status: 503, message: "" }), "server");
  assert.equal(classifyError({ name: "InstagramApiError", status: 404, message: "nope" }), "fatal");
  assert.equal(classifyError(new TypeError("Failed to fetch")), "network");
  assert.equal(classifyError(new Error("something else")), "fatal");
});

test("backoff grows exponentially, is capped, and honours Retry-After", () => {
  const mid = () => 0.5; // jitter factor 1.0
  assert.equal(computeBackoffSeconds(1, "rate-limit", undefined, mid), 30);
  assert.equal(computeBackoffSeconds(2, "rate-limit", undefined, mid), 60);
  assert.equal(computeBackoffSeconds(3, "rate-limit", undefined, mid), 120);
  assert.equal(computeBackoffSeconds(10, "rate-limit", undefined, mid), 300, "capped at 5 minutes");
  assert.equal(computeBackoffSeconds(1, "rate-limit", 200, mid), 200, "Retry-After wins when longer");
  assert.equal(computeBackoffSeconds(1, "network", undefined, mid), 5);
  assert.ok(computeBackoffSeconds(1, "rate-limit", 99999, mid) <= 600, "absurd Retry-After is bounded");
});

test("pace multiplier slows down fast, recovers slowly, and stays within 1..4", () => {
  let m = 1;
  for (let i = 0; i < 10; i++) m = adjustPaceMultiplier(m, "throttled");
  assert.equal(m, 4);
  for (let i = 0; i < 100; i++) m = adjustPaceMultiplier(m, "clean-page");
  assert.equal(m, 1);
});

// --- validation / security -------------------------------------------------

test("ids and usernames are strictly validated", () => {
  assert.equal(isValidInstagramId("123456"), true);
  for (const bad of ["", "12a", "../1", "1/2", "1?x=1", "-1", " 1", "9".repeat(21), 5, null, undefined]) {
    assert.equal(isValidInstagramId(bad), false, `id ${String(bad)}`);
  }
  assert.equal(isValidUsername("john.doe_99"), true);
  for (const bad of ["", "a b", "/evil.com", "//evil.com", "a".repeat(31), "<img>", "john@doe"]) {
    assert.equal(isValidUsername(bad), false, `username ${bad}`);
  }
});

test("only https image URLs survive", () => {
  assert.equal(sanitizeImageUrl("https://scontent.cdninstagram.com/a.jpg"), "https://scontent.cdninstagram.com/a.jpg");
  for (const bad of ["javascript:alert(1)", "http://x/a.jpg", "data:text/html,<script>", "//x/a.jpg", "not a url", 42]) {
    assert.equal(sanitizeImageUrl(bad), "", String(bad));
  }
});

test("sanitizeUserNode drops path-traversal ids and strips unknown fields", () => {
  assert.equal(sanitizeUserNode({ id: "../../accounts/logout", username: "bob" }), null);
  assert.equal(sanitizeUserNode({ id: "1", username: "//evil.com" }), null);
  assert.equal(sanitizeUserNode({ id: "pasted_bob_1_ab", username: "bob" }), null, "synthetic ids need allowSynthetic");
  assert.notEqual(sanitizeUserNode({ id: "pasted_bob_1_ab", username: "bob" }, true), null);
  const clean = sanitizeUserNode({ id: "7", username: "bob", profile_pic_url: "javascript:x", evil: "<script>", is_verified: "yes" });
  assert.ok(clean);
  assert.equal(clean.profile_pic_url, "");
  assert.equal(clean.is_verified, false, "only a real boolean true counts");
  assert.equal((clean as unknown as Record<string, unknown>).evil, undefined);
});

test("sanitizeUserList tolerates junk and de-duplicates", () => {
  assert.deepEqual(sanitizeUserList("nope"), []);
  const list = sanitizeUserList([{ id: "1", username: "a" }, { id: "1", username: "a" }, null, 5, { id: "x", username: "b" }]);
  assert.equal(list.length, 1);
});

test("clampTimings forces dangerous values back into the safe range", () => {
  const t = clampTimings({
    timeBetweenSearchCycles: 0,
    timeToWaitAfterFiveSearchCycles: -5,
    timeBetweenUnfollows: 1,
    timeToWaitAfterFiveUnfollows: 10,
    usersPerSearchCycle: 100000,
  });
  assert.equal(t.timeBetweenSearchCycles, 500);
  assert.equal(t.timeToWaitAfterFiveSearchCycles, 4000);
  assert.equal(t.timeBetweenUnfollows, 1000);
  assert.equal(t.timeToWaitAfterFiveUnfollows, 70000);
  assert.equal(t.usersPerSearchCycle, 200);
  const nan = clampTimings({ ...t, timeBetweenSearchCycles: NaN, usersPerSearchCycle: undefined });
  assert.equal(nan.timeBetweenSearchCycles, 1000);
  assert.equal(nan.usersPerSearchCycle, 50);
});

// --- whitelist protection --------------------------------------------------

test("a whitelisted USERNAME (pasted entry with a synthetic id) hides the real account", () => {
  const real = { id: "42", username: "Bob", full_name: "", profile_pic_url: "https://x/y.jpg", is_private: false, is_verified: false, followed_by_viewer: true, follows_viewer: false, requested_by_viewer: false };
  const pasted = { ...real, id: "pasted_bob_1_ab", username: "bob", profile_pic_url: "" };
  const filter = { showVerified: true, showPrivate: true, showWithOutProfilePicture: true };
  assert.equal(getUsersForDisplay([real], [pasted], "non_whitelisted", "", filter).length, 0);
  assert.equal(getUsersForDisplay([real], [pasted], "whitelisted", "", filter).length, 1);
});

test("mergeWhitelists de-duplicates by username too", () => {
  const a = { id: "1", username: "bob", full_name: "", profile_pic_url: "", is_private: false, is_verified: false, followed_by_viewer: true, follows_viewer: false, requested_by_viewer: false };
  const b = { ...a, id: "pasted_bob_1_ab", username: "BOB" };
  assert.equal(mergeWhitelists([a], [b]).length, 1);
});

// --- scan checkpoint persistence -------------------------------------------

import {
  checkpointPercentage,
  createScanCheckpoint,
  deserializeCheckpoint,
  followersPhasePercentage,
  followingPhasePercentage,
  serializeCheckpoint,
} from "../src/utils/scan-persistence";
import { SCAN_CHECKPOINT_MAX_AGE_MS } from "../src/constants/constants";
import { isUserNodeInFollowerIndex } from "../src/utils/utils";

const candidate = (id: string, username: string) => {
  const user = sanitizeUserNode({ id, username, follows_viewer: false, profile_pic_url: "https://example.com/p.jpg" });
  assert.ok(user);
  return user;
};

// Following list fully loaded, followers pass partway through.
const followersPassCheckpoint = () => {
  const cp = createScanCheckpoint("123");
  cp.followingCursor.done = true;
  cp.followingCursor.pagesFetched = 3;
  cp.followingCount = 3;
  cp.candidates = [candidate("99", "ghost.user"), candidate("98", "other.ghost")];
  cp.seenFollowingIds.add("99");
  cp.seenFollowingIds.add("98");
  cp.followerIndex.ids.add("1");
  cp.followerIndex.usernames.add("alice");
  cp.followersCount = 75;
  cp.followersCursor.maxId = "cursor-abc";
  cp.followersCursor.pagesFetched = 3;
  return cp;
};

// Still loading the following list.
const followingPassCheckpoint = () => {
  const cp = createScanCheckpoint("123");
  cp.followingCursor.maxId = "c1";
  cp.followingCursor.pagesFetched = 2;
  cp.followingCount = 50;
  cp.candidates = [candidate("99", "ghost.user"), candidate("98", "other.ghost")];
  return cp;
};

test("a checkpoint survives a serialize / deserialize round trip", () => {
  const original = followersPassCheckpoint();
  const restored = deserializeCheckpoint(serializeCheckpoint(original, 1000), "123", 2000);
  assert.ok(restored);
  const cp = restored.checkpoint;
  assert.deepEqual(Array.from(cp.followerIndex.ids), ["1"]);
  assert.deepEqual(Array.from(cp.followerIndex.usernames), ["alice"]);
  assert.equal(cp.followersCount, 75);
  assert.equal(cp.followingCount, 3);
  assert.equal(cp.followingCursor.done, true);
  assert.equal(cp.followersCursor.maxId, "cursor-abc");
  assert.deepEqual(cp.candidates.map(u => u.id), ["99", "98"]);
  assert.ok(cp.seenFollowingIds.has("98"));
  assert.equal(checkpointPercentage(cp), checkpointPercentage(original));
});

test("avatar URLs are not stored (size), the rest of a candidate is", () => {
  const restored = deserializeCheckpoint(serializeCheckpoint(followersPassCheckpoint(), 1000), "123", 2000);
  assert.ok(restored);
  assert.equal(restored.checkpoint.candidates[0].profile_pic_url, "");
  assert.equal(restored.checkpoint.candidates[0].username, "ghost.user");
});

test("a mid-following checkpoint round trips too", () => {
  const restored = deserializeCheckpoint(serializeCheckpoint(followingPassCheckpoint(), 1000), "123", 2000);
  assert.ok(restored);
  assert.equal(restored.checkpoint.candidates.length, 2);
  assert.equal(restored.checkpoint.followingCursor.maxId, "c1");
  assert.equal(restored.checkpoint.followingCursor.done, false);
});

test("a checkpoint is rejected for another account, when stale, or when corrupt", () => {
  const raw = serializeCheckpoint(followersPassCheckpoint(), 1000);
  assert.equal(deserializeCheckpoint(raw, "456", 2000), null);
  assert.equal(deserializeCheckpoint(raw, "123", 1000 + SCAN_CHECKPOINT_MAX_AGE_MS + 1), null);
  assert.equal(deserializeCheckpoint(null, "123", 2000), null);
  assert.equal(deserializeCheckpoint("{not json", "123", 2000), null);
  assert.equal(deserializeCheckpoint(JSON.stringify({ v: 1 }), "123", 2000), null);
});

test("a checkpoint with a damaged follower index is rejected, never trusted", () => {
  const parsed = JSON.parse(serializeCheckpoint(followersPassCheckpoint(), 1000));
  parsed.followerIds = ["1", 2];
  assert.equal(deserializeCheckpoint(JSON.stringify(parsed), "123", 2000), null);
});

test("a mid-following checkpoint that lost candidates is rejected", () => {
  const parsed = JSON.parse(serializeCheckpoint(followingPassCheckpoint(), 1000));
  parsed.candidates[0].id = "../evil";
  assert.equal(deserializeCheckpoint(JSON.stringify(parsed), "123", 2000), null);
});

test("a checkpoint claiming follower progress before following finished is rejected", () => {
  const cp = followersPassCheckpoint();
  cp.followingCursor.done = false;
  assert.equal(deserializeCheckpoint(serializeCheckpoint(cp, 1000), "123", 2000), null);
});

test("percentages: following fills 0-49, followers fills 50-99, never 100", () => {
  assert.equal(followingPhasePercentage(0), 0);
  assert.ok(followingPhasePercentage(100000) <= 49);
  assert.ok(followersPhasePercentage(0) >= 50);
  assert.ok(followersPhasePercentage(100000) <= 99);
  const cp = createScanCheckpoint("123");
  cp.followingCount = 500;
  const during = checkpointPercentage(cp);
  cp.followingCursor.done = true;
  assert.ok(checkpointPercentage(cp) >= 50 && checkpointPercentage(cp) > during);
});

test("candidates who follow back are matched by id or by lowercase username", () => {
  const index = { ids: new Set(["10"]), usernames: new Set(["bob"]) };
  assert.equal(isUserNodeInFollowerIndex(index, { id: "10", username: "Whoever" }), true);
  assert.equal(isUserNodeInFollowerIndex(index, { id: "11", username: "Bob" }), true);
  assert.equal(isUserNodeInFollowerIndex(index, { id: "11", username: "carol" }), false);
});

// --- timers -----------------------------------------------------------------

import { hasUnthrottledTimers, sleep } from "../src/utils/utils";

test("sleep still resolves when no Web Worker is available (falls back to setTimeout)", async () => {
  assert.equal(hasUnthrottledTimers(), false); // plain Node has no Worker global
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 15);
});
