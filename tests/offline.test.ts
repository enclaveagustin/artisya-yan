import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { kindFromFileName, parseInstagramExport, usernameFromHref } from "../src/offline/instagram-export";
import {
  AppData,
  addFollowerFile,
  analyze,
  emptyData,
  markUnfollowed,
  setDeactivated,
  setNewUsername,
  setWhitelisted,
  undoUnfollowed,
} from "../src/offline/model";
import { readXlsx, writeXlsx } from "../src/offline/xlsx";
import { dataFromSheets, readWorkbook, sheetsFromData, writeWorkbook } from "../src/offline/workbook";

// --- Instagram export parsing -----------------------------------------------

const followersFile = JSON.stringify([
  { title: "", media_list_data: [], string_list_data: [{ href: "https://www.instagram.com/alice", value: "alice", timestamp: 1 }] },
  { title: "", media_list_data: [], string_list_data: [{ href: "https://www.instagram.com/Bob.Smith", value: "Bob.Smith", timestamp: 2 }] },
  { title: "", media_list_data: [], string_list_data: [{ href: "https://www.instagram.com/alice", value: "ALICE", timestamp: 3 }] },
]);
const followingFile = JSON.stringify({
  relationships_following: [
    { title: "carol", media_list_data: [], string_list_data: [{ href: "https://www.instagram.com/_u/carol", timestamp: 1 }] },
    { title: "", string_list_data: [{ href: "https://www.instagram.com/_u/dave_99", timestamp: 2 }] },
    { title: "not a username!", string_list_data: [] },
  ],
});

test("followers_1.json: usernames from `value`, de-duplicated case-insensitively", () => {
  const result = parseInstagramExport(followersFile, "followers_1.json");
  assert.deepEqual(result.usernames, ["alice", "Bob.Smith"]);
  assert.equal(result.kind, "followers");
  assert.equal(result.skipped, 0);
});

test("following.json: usernames from `title`, falling back to the profile link; bad entries counted", () => {
  const result = parseInstagramExport(followingFile, "whatever.json");
  assert.deepEqual(result.usernames, ["carol", "dave_99"]);
  assert.equal(result.kind, "following"); // from the relationships_following key, not the file name
  assert.equal(result.skipped, 1);
});

test("plain string arrays, BOMs and file-name guessing work", () => {
  const result = parseInstagramExport("﻿" + JSON.stringify(["x1", "y2"]), "my_followers.json");
  assert.deepEqual(result.usernames, ["x1", "y2"]);
  assert.equal(result.kind, "followers");
  assert.equal(kindFromFileName("following.json"), "following");
  assert.equal(kindFromFileName("data.json"), "unknown");
});

test("invalid or empty files give a clear error", () => {
  assert.throws(() => parseInstagramExport("{nope"), /not valid JSON/);
  assert.throws(() => parseInstagramExport("[]"), /No Instagram usernames/);
});

test("profile links only count on instagram.com", () => {
  assert.equal(usernameFromHref("https://www.instagram.com/_u/eve"), "eve");
  assert.equal(usernameFromHref("https://evil.example/eve"), null);
  assert.equal(usernameFromHref("https://www.instagram.com/p/abc/"), null);
  assert.equal(usernameFromHref(42), null);
});

// --- analysis -----------------------------------------------------------------

const baseData = (): AppData => {
  let data = emptyData();
  data = { ...data, following: { name: "following.json", usernames: ["alice", "carol", "dave_99", "erin", "frank", "gina"] } };
  data = addFollowerFile(data, { name: "followers_1.json", usernames: ["Alice", "zed"] });
  return data;
};

test("non-followers are compared case-insensitively; followers of yours are mutual", () => {
  const a = analyze(baseData());
  assert.equal(a.followingCount, 6);
  assert.equal(a.followersCount, 2);
  assert.equal(a.mutualCount, 1);
  assert.deepEqual(a.buckets.toReview.map(r => r.username), ["carol", "dave_99", "erin", "frank", "gina"]);
});

test("several followers files are merged", () => {
  const data = addFollowerFile(baseData(), { name: "followers_2.json", usernames: ["carol"] });
  assert.deepEqual(analyze(data).buckets.toReview.map(r => r.username), ["dave_99", "erin", "frank", "gina"]);
  assert.equal(analyze(data).followersCount, 3);
});

test("whitelisted, deactivated, renamed and already-unfollowed accounts leave the review list", () => {
  let data = baseData();
  data = addFollowerFile(data, { name: "followers_2.json", usernames: ["erin_new"] });
  data = setWhitelisted(data, "carol", true);
  data = setDeactivated(data, "dave_99", true);
  data = setNewUsername(data, "erin", "@erin_new");
  data = markUnfollowed(data, "frank", "2026-11-19");
  const a = analyze(data);
  assert.deepEqual(a.buckets.toReview.map(r => r.username), ["gina"]);
  assert.deepEqual(a.buckets.whitelisted.map(r => r.username), ["carol"]);
  assert.deepEqual(a.buckets.deactivated.map(r => r.username), ["dave_99"]);
  assert.deepEqual(a.buckets.renamed.map(r => r.username), ["erin"]);
  assert.deepEqual(a.buckets.unfollowed.map(r => r.username), ["frank"]);
});

test("a rename that does not follow you under the new name stays in review", () => {
  const data = setNewUsername(baseData(), "erin", "erin_new");
  assert.ok(analyze(data).buckets.toReview.some(r => r.username === "erin"));
});

test("edits are undoable and an account with no notes left is dropped", () => {
  let data = setWhitelisted(baseData(), "carol", true);
  assert.equal(data.accounts.length, 1);
  data = setWhitelisted(data, "CAROL", false);
  assert.equal(data.accounts.length, 0);
  data = markUnfollowed(data, "gina", "2026-11-19");
  assert.equal(data.unfollowed.length, 1);
  assert.equal(undoUnfollowed(data, "GINA").unfollowed.length, 0);
});

test("an invalid new username clears the rename instead of storing junk", () => {
  let data = setNewUsername(baseData(), "erin", "erin_new");
  assert.equal(data.accounts[0].newUsername, "erin_new");
  data = setNewUsername(data, "erin", "not a handle!");
  assert.equal(data.accounts.length, 0);
});

// --- xlsx ---------------------------------------------------------------------

test("xlsx round trip keeps text, special characters and blanks", () => {
  const rows = [["a", "b", "c"], ["x & <y>", "", "\"q\""], ["", "only third", "tab\there"]];
  const sheets = readXlsx(writeXlsx([{ name: "t", rows }]));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "t");
  assert.deepEqual(sheets[0].rows.map(r => Array.from(r)), [["a", "b", "c"], ["x & <y>", "", "\"q\""], ["", "only third", "tab\there"]]);
});

test("instagram links are written as clickable HYPERLINK cells and read back as text", () => {
  const link = "https://www.instagram.com/alice";
  const bytes = writeXlsx([{ name: "s", rows: [["username", "profile_link"], ["alice", link]] }]);
  const sheets = readXlsx(bytes);
  assert.equal(sheets[0].rows[1][1], link);
});

test("reads a workbook the way Excel / Google Sheets write it (shared strings, absolute targets)", () => {
  const xml = (s: string) => strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + s);
  const bytes = zipSync({
    "[Content_Types].xml": xml("<Types/>"),
    "xl/workbook.xml": xml('<workbook xmlns:r="x"><sheets><sheet name="white_list" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": xml('<Relationships><Relationship Id="rId1" Type="t" Target="/xl/worksheets/sheet1.xml"/></Relationships>'),
    "xl/sharedStrings.xml": xml("<sst><si><t>username</t></si><si><t>is_whitelisted</t></si><si><r><t>val</t></r><r><t>orant_askthing</t></r></si><si><t>y</t></si></sst>"),
    "xl/worksheets/sheet1.xml": xml('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c></row></sheetData></worksheet>'),
  });
  const sheets = readXlsx(bytes);
  assert.equal(sheets[0].rows[1][0], "valorant_askthing");
  assert.equal(sheets[0].rows[1][2], "y");
  const parsed = dataFromSheets(sheets);
  assert.equal(parsed.accounts[0].username, "valorant_askthing");
  assert.equal(parsed.accounts[0].isWhitelisted, true);
});

test("a file that is not a workbook is rejected clearly", () => {
  assert.throws(() => readXlsx(new Uint8Array([1, 2, 3])), /not a valid \.xlsx/);
  assert.throws(() => readWorkbook(writeXlsx([{ name: "other", rows: [["a"]] }])), /no "white_list" or "unfollowed" sheet/);
});

// --- workbook <-> data --------------------------------------------------------

test("the base workbook has the four tabs and the columns from the template", () => {
  let data = setWhitelisted(baseData(), "carol", true);
  data = setDeactivated(data, "dave_99", true);
  data = markUnfollowed(data, "gina", "2026-11-19");
  const sheets = sheetsFromData(data);
  assert.deepEqual(sheets.map(s => s.name), ["white_list", "new_followingxfollowers", "unfollowed", "followers_snapshot"]);
  assert.deepEqual(Array.from(sheets[0].rows[0]), ["username", "profile_link", "is_whitelisted", "is_deactivated", "new_username", "unfollowed", "is_deleted", "last_checked", "check_result"]);
  assert.deepEqual(Array.from(sheets[1].rows[0]), ["username", "profile_link", "is_whitelisted", "is_deactivated", "new_username", "unfollowed", "is_deleted", "last_checked", "check_result"]);
  assert.deepEqual(Array.from(sheets[2].rows[0]), ["username", "profile_link", "unfollowed_on"]);
  // dave_99 is deactivated (own bucket), carol whitelisted, gina unfollowed: only erin and frank still need review.
  assert.deepEqual(sheets[1].rows.slice(1).map(r => r[0]), ["erin", "frank"]);
});

test("saving then loading a workbook returns the same whitelist and unfollowed log", () => {
  let data = setWhitelisted(baseData(), "carol", true);
  data = setNewUsername(data, "erin", "erin_new");
  data = setDeactivated(data, "dave_99", true);
  data = markUnfollowed(data, "gina", "2026-11-19");
  const loaded = readWorkbook(writeWorkbook(data));
  const byName = (name: string) => loaded.accounts.filter(a => a.username === name)[0];
  assert.equal(loaded.accounts.length, 3);
  assert.equal(byName("carol").isWhitelisted, true);
  assert.equal(byName("dave_99").isDeactivated, true);
  assert.equal(byName("erin").newUsername, "erin_new");
  assert.deepEqual(loaded.unfollowed, [{ username: "gina", date: "2026-11-19" }]);
  assert.equal(loaded.skippedRows, 0);
});

test("rows from a hand-kept sheet load: y flags, plain rows, link-only rows, junk skipped", () => {
  const rows = [
    ["username", "profile_link", "is_whitelisted", "is_deactivated", "new_username", "unfollowed"],
    ["_mnldan", "https://www.instagram.com/_mnldan", "y", "", ""],
    ["carlosmiguelmllr_", "https://www.instagram.com/carlosmiguelmllr_", "", "Y", ""],
    ["eyebandelara", "https://www.instagram.com/eyebandelara", "", "", ""],
    ["", "https://www.instagram.com/onlylink", "yes", "", ""],
    ["not valid!!", "", "", "", ""],
    ["", "", "", "", ""],
    ["_mnldan", "https://www.instagram.com/_mnldan", "y", "", ""],
  ];
  const result = dataFromSheets([{ name: "White_List", rows }]);
  assert.deepEqual(result.accounts.map(a => a.username), ["_mnldan", "carlosmiguelmllr_", "eyebandelara", "onlylink"]);
  assert.equal(result.accounts[3].isWhitelisted, true);
  assert.equal(result.accounts[1].isDeactivated, true);
  assert.equal(result.skippedRows, 2); // the invalid name and the duplicate
});

// --- restoring saved data -----------------------------------------------------

import { sanitizeData } from "../src/offline/model";

test("saved browser data is rebuilt field by field; junk is dropped", () => {
  const data = sanitizeData({
    accounts: [
      { username: "ok_user", isWhitelisted: true, newUsername: "ok_new", extra: "<script>" },
      { username: "../evil" },
      "nope",
    ],
    unfollowed: [{ username: "gone", date: "2026-11-19" }, { username: 5 }],
    following: { name: "following.json", usernames: ["a1", "bad name", 3] },
    followerFiles: [{ name: "followers_1.json", usernames: ["b2"] }, null],
  });
  assert.deepEqual(data.accounts, [{ username: "ok_user", isWhitelisted: true, isDeactivated: false, newUsername: "ok_new", unfollowedYou: false, isDeleted: false, lastChecked: "", checkResult: "", extra: {} }]);
  assert.deepEqual(data.unfollowed, [{ username: "gone", date: "2026-11-19" }]);
  assert.deepEqual(data.following, { name: "following.json", usernames: ["a1"] });
  assert.equal(data.followerFiles.length, 1);
  assert.deepEqual(sanitizeData("garbage"), emptyData());
});

// --- "unfollowed" column (accounts proven to have unfollowed you) ----------------

import { setUnfollowedYou } from "../src/offline/model";

test("the unfollowed column is tracked, saved, reloaded and clearable", () => {
  let data = setUnfollowedYou(baseData(), "carol", true);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].unfollowedYou, true);
  const loaded = readWorkbook(writeWorkbook(data));
  assert.equal(loaded.accounts[0].username, "carol");
  assert.equal(loaded.accounts[0].unfollowedYou, true);
  data = setUnfollowedYou(data, "carol", false);
  assert.equal(data.accounts.length, 0);
});

test("tracking an unfollower does not remove them from review", () => {
  const data = setUnfollowedYou(baseData(), "carol", true);
  assert.ok(analyze(data).buckets.toReview.some(r => r.username === "carol"));
});

test("columns are found by header name, in any order, and extra columns of your own kept", () => {
  const rows = [
    ["notes", "unfollowed", "username", "is_deactivated", "profile_link", "is_whitelisted"],
    ["hello", "y", "zed_1", "", "https://www.instagram.com/zed_1", ""],
    ["", "", "amy_2", "y", "https://www.instagram.com/amy_2", "y"],
  ];
  const result = dataFromSheets([{ name: "white_list", rows }]);
  assert.deepEqual(result.accounts, [
    { username: "zed_1", isWhitelisted: false, isDeactivated: false, newUsername: "", unfollowedYou: true, isDeleted: false, lastChecked: "", checkResult: "", extra: { notes: "hello" } },
    { username: "amy_2", isWhitelisted: true, isDeactivated: true, newUsername: "", unfollowedYou: false, isDeleted: false, lastChecked: "", checkResult: "", extra: {} },
  ]);
});

test("an older workbook without the unfollowed column still loads", () => {
  const rows = [
    ["username", "profile_link", "is_whitelisted", "is_deactivated", "new_username"],
    ["old_1", "https://www.instagram.com/old_1", "y", "", ""],
  ];
  const result = dataFromSheets([{ name: "white_list", rows }]);
  assert.equal(result.accounts[0].isWhitelisted, true);
  assert.equal(result.accounts[0].unfollowedYou, false);
});

// --- HTML export (followers_1.html / following.html) and is_deleted --------------

import { parseInstagramHtml } from "../src/offline/instagram-export";
import { isDeletedUsername, setDeleted } from "../src/offline/model";

const followersHtml = `<html><head><title>Followers</title></head><body>
<header><h1>Followers</h1></header><main>
<div class="pam"><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/alice">alice</a></div><div>Nov 19, 2026 5:30 am</div></div></div></div>
<div class="pam"><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/Bob.Smith">Bob.Smith</a></div><div>Nov 18, 2026</div></div></div></div>
<div class="pam"><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/alice">alice</a></div></div></div></div>
</main></body></html>`;

const followingHtml = `<html><head><title>Following</title></head><body><main>
<div class="pam"><h2 class="x">carol</h2><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/_u/carol">https://www.instagram.com/_u/carol</a></div></div></div></div>
<div class="pam"><h2 class="x">__deleted__bhiebegidbhhgfbea</h2><div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/_u/__deleted__bhiebegidbhhgfbea">x</a></div></div></div></div>
<a href="https://www.instagram.com/p/abc123/">a post link, not a profile</a>
</main></body></html>`;

test("followers_1.html: profile links become usernames, de-duplicated, kind from the title", () => {
  const result = parseInstagramExport(followersHtml, "followers_1.html");
  assert.deepEqual(result.usernames, ["alice", "Bob.Smith"]);
  assert.equal(result.kind, "followers");
  assert.equal(result.skipped, 0);
});

test("following.html: /_u/ links work, non-profile links are skipped, kind from the title", () => {
  const result = parseInstagramExport(followingHtml, "following.html");
  assert.deepEqual(result.usernames, ["carol", "__deleted__bhiebegidbhhgfbea"]);
  assert.equal(result.kind, "following");
  assert.equal(result.skipped, 1);
});

test("HTML is recognised by content too, and the file name decides when the title does not", () => {
  const untitled = "<!doctype html><html><body><a href=\"https://www.instagram.com/zed\">zed</a></body></html>";
  const result = parseInstagramExport(untitled, "my_followers_copy.txt");
  assert.deepEqual(result.usernames, ["zed"]);
  assert.equal(result.kind, "followers");
  assert.throws(() => parseInstagramHtml("<html><body>nothing here</body></html>"), /No Instagram usernames/);
});

test("accounts Instagram lists as __deleted__ go to the deleted bucket by themselves", () => {
  assert.equal(isDeletedUsername("__deleted__abc"), true);
  assert.equal(isDeletedUsername("not_deleted"), false);
  const parsed = parseInstagramExport(followingHtml, "following.html");
  let data: AppData = { ...emptyData(), following: { name: "following.html", usernames: parsed.usernames } };
  data = addFollowerFile(data, { name: "followers_1.html", usernames: ["alice"] });
  const a = analyze(data);
  assert.deepEqual(a.buckets.deleted.map(r => r.username), ["__deleted__bhiebegidbhhgfbea"]);
  assert.deepEqual(a.buckets.toReview.map(r => r.username), ["carol"]);
});

test("the is_deleted column is read, written and togglable; a whitelist entry still wins", () => {
  let data = setDeleted(baseData(), "carol", true);
  assert.deepEqual(analyze(data).buckets.deleted.map(r => r.username), ["carol"]);
  const loaded = readWorkbook(writeWorkbook(data));
  assert.equal(loaded.accounts[0].isDeleted, true);
  data = setWhitelisted(data, "carol", true);
  assert.deepEqual(analyze(data).buckets.whitelisted.map(r => r.username), ["carol"]);
  data = setDeleted(setWhitelisted(data, "carol", false), "carol", false);
  assert.equal(data.accounts.length, 0);
});

test("the workbook layout matches the user's sheet: nine columns in this order (the original seven, then the two recheck columns)", () => {
  const rows = sheetsFromData(emptyData())[0].rows;
  assert.deepEqual(Array.from(rows[0]), ["username", "profile_link", "is_whitelisted", "is_deactivated", "new_username", "unfollowed", "is_deleted", "last_checked", "check_result"]);
});

// --- reactivated / missing accounts, and the recently-unfollowed list ----------------

import { setRecentlyUnfollowed } from "../src/offline/model";

const unfollowedTableHtml = `<html><head><title>Recently unfollowed profiles</title></head><body><main>
<div class="pam"><table><tr><td class="_a6_q">Name</td><td class="x">Some Name</td></tr><tr><td class="_a6_q">Username</td><td class="x">gina</td></tr></table></div><div class="d">Nov 18, 2026 3:01 pm</div>
<div class="pam"><table><tr><td class="_a6_q">Name</td><td class="x">Other</td></tr><tr><td class="_a6_q">Username</td><td class="x">frank</td></tr></table></div><div class="d">Nov 18, 2026 3:02 pm</div>
</main></body></html>`;

test("recently_unfollowed_profiles.html (no links, Name/Username tables) is read and recognised", () => {
  const result = parseInstagramExport(unfollowedTableHtml, "recently_unfollowed_profiles.html");
  assert.deepEqual(result.usernames, ["gina", "frank"]);
  assert.equal(result.kind, "recentlyUnfollowed");
});

test("other table lists (favorites, close friends, ...) are recognised as not needed", () => {
  const html = unfollowedTableHtml.replace("Recently unfollowed profiles", "Close Friends");
  assert.equal(parseInstagramExport(html, "close_friends.html").kind, "other");
});

test("a deactivated or deleted mark on an account that follows you means it is active again", () => {
  let data = baseData(); // followers: Alice, zed
  data = setDeactivated(data, "alice", true);
  data = setDeleted(data, "zed", true);
  const a = analyze(data);
  assert.deepEqual(a.activeAgain.map(r => r.username).sort(), ["alice", "zed"]);
  assert.equal(analyze(setDeactivated(baseData(), "carol", true)).activeAgain.length, 0); // carol does not follow
});

test("an account from the sheet that vanished from both lists is flagged missing, unless you unfollowed it", () => {
  let data = baseData();
  data = setDeactivated(data, "ghost_one", true); // not in following, not in followers
  data = setDeactivated(data, "ghost_two", true);
  data = setDeactivated(data, "ghost_three", true);
  data = setNewUsername(data, "ghost_three", "alice"); // renamed, and found (alice is in the lists)
  assert.deepEqual(analyze(data).missing.map(r => r.username).sort(), ["ghost_one", "ghost_two"]);
  const withLog = setRecentlyUnfollowed(data, { name: "recently_unfollowed_profiles.html", usernames: ["ghost_two"] });
  assert.deepEqual(analyze(withLog).missing.map(r => r.username), ["ghost_one"]);
  assert.deepEqual(analyze(markUnfollowed(withLog, "ghost_one", "2026-11-21")).missing.map(r => r.username), []);
  assert.deepEqual(analyze(setDeleted(withLog, "ghost_one", true)).missing.map(r => r.username), []);
});

test("missing and active-again need the following list; deletedInExport counts the nameless entries", () => {
  const noFollowing = { ...setDeactivated(emptyData(), "ghost_one", true) };
  assert.deepEqual(analyze(noFollowing).missing, []);
  const withDeleted: AppData = { ...emptyData(), following: { name: "f", usernames: ["a1", "__deleted__x1", "__deleted__x2"] } };
  assert.equal(analyze(withDeleted).deletedInExport, 2);
});

// --- recheck of deactivated accounts --------------------------------------------------

import { RECHECK_BATCH_SIZES, RecheckOptions, clearRechecks, daysBetween, hasRechecks, recheckQueue, recordRecheck } from "../src/offline/model";

const opts = (over: Partial<RecheckOptions> = {}): RecheckOptions => ({ today: "2026-11-21", maxAgeDays: null, order: "newest", ...over });

test("recheck: 'works' clears the deactivated mark, 'unavailable' sets it; both leave a dated note on the account", () => {
  let data = setDeactivated(setDeactivated(baseData(), "carol", true), "dave_99", true);
  data = recordRecheck(data, "carol", "works", "2026-11-21");
  data = recordRecheck(data, "dave_99", "unavailable", "2026-11-21");
  const byName = (n: string) => data.accounts.filter(a => a.username === n)[0];
  assert.equal(byName("carol").isDeactivated, false);
  assert.deepEqual([byName("carol").checkResult, byName("carol").lastChecked], ["works", "2026-11-21"]);
  assert.equal(byName("dave_99").isDeactivated, true);
  assert.equal(byName("dave_99").checkResult, "unavailable");
  assert.ok(hasRechecks(data));
  assert.ok(analyze(data).buckets.toReview.some(r => r.username === "carol")); // active and not following back: back to review
  assert.ok(analyze(data).buckets.deactivated.some(r => r.username === "dave_99"));
});

test("recheck queue: skips rechecked accounts, can expire old checks, and orders newest / oldest / A-Z", () => {
  let data = baseData();
  const names = ["g1", "b2", "e3", "a4", "f5", "c6", "d7"];
  data = { ...data, following: { name: "following.html", usernames: names } };
  for (const n of names) {
    data = setDeactivated(data, n, true);
  }
  const rows = () => analyze(data).buckets.deactivated;
  const queue = (o: RecheckOptions) => recheckQueue(rows(), o).map(r => r.username);
  assert.deepEqual(RECHECK_BATCH_SIZES, [5, 10, 20]);
  assert.deepEqual(queue(opts()), names); // newest follow first = list order
  assert.deepEqual(queue(opts({ order: "oldest" })), names.slice().reverse());
  assert.deepEqual(queue(opts({ order: "az" })), ["a4", "b2", "c6", "d7", "e3", "f5", "g1"]);
  data = recordRecheck(data, "g1", "unavailable", "2026-11-20");
  data = recordRecheck(data, "B2", "unavailable", "2026-08-01"); // case-insensitive
  assert.deepEqual(queue(opts()), ["e3", "a4", "f5", "c6", "d7"]); // never expires: both skipped
  assert.deepEqual(queue(opts({ maxAgeDays: 90 })), ["b2", "e3", "a4", "f5", "c6", "d7"]); // b2 was 112 days ago: due again
  assert.deepEqual(queue(opts({ maxAgeDays: 30 })), ["b2", "e3", "a4", "f5", "c6", "d7"]); // g1 is 1 day old: still skipped
  const cleared = clearRechecks(data);
  assert.equal(hasRechecks(cleared), false);
  assert.equal(cleared.accounts.length, data.accounts.length); // the deactivated marks themselves stay
});

test("daysBetween counts whole days and refuses garbage", () => {
  assert.equal(daysBetween("2026-11-20", "2026-11-21"), 1);
  assert.equal(daysBetween("2026-08-01", "2026-11-21"), 112);
  assert.equal(daysBetween("not a date", "2026-11-21"), Infinity);
});

test("check notes survive the browser copy, and an old copy with a separate rechecks list is folded in", () => {
  const data = recordRecheck(setDeactivated(baseData(), "carol", true), "carol", "unavailable", "2026-11-21");
  const restored = sanitizeData(JSON.parse(JSON.stringify(data)));
  assert.deepEqual([restored.accounts[0].lastChecked, restored.accounts[0].checkResult], ["2026-11-21", "unavailable"]);
  const old = sanitizeData({
    accounts: [{ username: "fine", isDeactivated: true }],
    rechecks: [{ username: "../x", result: "works" }, { username: "fine", result: "maybe" }, { username: "fine", result: "works", date: "2026-11-01" }],
  });
  assert.deepEqual([old.accounts[0].lastChecked, old.accounts[0].checkResult], ["2026-11-01", "works"]);
});

// --- recheck also covers WHITELISTED accounts ---------------------------------------------

test("a whitelisted account can be found deactivated: it keeps the whitelist flag and gains the deactivated one", () => {
  let data = setWhitelisted(baseData(), "carol", true);
  assert.deepEqual(analyze(data).buckets.whitelisted.map(r => r.username), ["carol"]);
  data = recordRecheck(data, "carol", "unavailable", "2026-11-21");
  const carol = data.accounts.filter(a => a.username === "carol")[0];
  assert.equal(carol.isWhitelisted, true);
  assert.equal(carol.isDeactivated, true);
  assert.deepEqual(analyze(data).buckets.whitelisted.map(r => r.username), ["carol"]); // still protected
  assert.equal(analyze(data).buckets.deactivated.length, 0); // whitelist still wins the bucket
  // ... and a later "works" clears only the deactivated mark.
  data = recordRecheck(data, "carol", "works", "2026-11-22");
  const again = data.accounts.filter(a => a.username === "carol")[0];
  assert.equal(again.isWhitelisted, true);
  assert.equal(again.isDeactivated, false);
});

test("the whitelist recheck queue is the whitelisted rows that are due", () => {
  let data = baseData();
  for (const n of ["carol", "dave_99", "erin"]) {
    data = setWhitelisted(data, n, true);
  }
  data = recordRecheck(data, "dave_99", "works", "2026-11-21");
  const queue = recheckQueue(analyze(data).buckets.whitelisted, opts()).map(r => r.username);
  assert.deepEqual(queue, ["carol", "erin"]);
});

// --- the workbook is yours: nothing of it is lost on save ------------------------------------

import { dataFromSheets as readSheets, normalizeDate, sheetsFromData as writeSheets, whiteListHeaderFor } from "../src/offline/workbook";

const customSheets = () => [
  {
    name: "white_list",
    rows: [
      ["notes", "username", "profile_link", "is_whitelisted", "Group", "is_deactivated"],
      ["met at gym", "zed_1", "https://www.instagram.com/zed_1", "y", "friends", ""],
      ["", "amy_2", "https://www.instagram.com/amy_2", "", "", "y"],
      ["cousin", "bob_3", "https://www.instagram.com/bob_3", "y", "family", ""],
    ],
  },
  { name: "Budget", rows: [["item", "cost"], ["phone", "100"]] },
];

test("columns of your own are read, kept per account, and written back where they were", () => {
  const read = readSheets(customSheets());
  assert.deepEqual(read.extraColumns, ["notes", "Group"]);
  assert.deepEqual(read.accounts.map(a => a.extra), [{ notes: "met at gym", Group: "friends" }, {}, { notes: "cousin", Group: "family" }]);
  const data: AppData = { ...emptyData(), accounts: read.accounts, whiteListHeader: read.whiteListHeader, extraSheets: read.extraSheets };
  const out = writeSheets(data)[0].rows.map(r => Array.from(r));
  assert.deepEqual(out[0].slice(0, 6), ["notes", "username", "profile_link", "is_whitelisted", "Group", "is_deactivated"]); // your order
  assert.deepEqual(out[0].slice(6), ["new_username", "unfollowed", "is_deleted", "last_checked", "check_result"]); // missing standard columns appended
  assert.equal(out[1][0], "met at gym");
  assert.equal(out[1][4], "friends");
  assert.equal(out[3][0], "cousin");
});

test("row order is kept (not re-sorted) and an edited account stays in its row", () => {
  const read = readSheets(customSheets());
  let data: AppData = { ...emptyData(), accounts: read.accounts, whiteListHeader: read.whiteListHeader };
  data = setDeactivated(data, "zed_1", true);
  data = setWhitelisted(data, "new_one", true);
  const names = writeSheets(data)[0].rows.slice(1).map(r => r[1]);
  assert.deepEqual(names, ["zed_1", "amy_2", "bob_3", "new_one"]); // zed_1 did not jump; the new account is last
});

test("other sheets travel through a save untouched, and a custom-only row is not dropped", () => {
  const read = readSheets(customSheets());
  let data: AppData = { ...emptyData(), accounts: read.accounts, whiteListHeader: read.whiteListHeader, extraSheets: read.extraSheets };
  data = setDeactivated(setDeactivated(data, "bob_3", true), "bob_3", false); // clear the flags: the "cousin" note must keep the row
  data = setWhitelisted(data, "bob_3", false);
  const sheets = writeSheets(data);
  assert.deepEqual(sheets.map(s => s.name), ["white_list", "new_followingxfollowers", "unfollowed", "followers_snapshot", "Budget"]);
  assert.deepEqual(sheets[4].rows.map(r => Array.from(r)), [["item", "cost"], ["phone", "100"]]);
  assert.ok(sheets[0].rows.some(r => r[1] === "bob_3"));
  // and the whole thing survives a real save -> load
  const loaded = readWorkbook(writeWorkbook(data));
  assert.deepEqual(loaded.extraColumns, ["notes", "Group"]);
  assert.equal(loaded.extraSheets[0].name, "Budget");
  assert.equal(loaded.accounts.filter(a => a.username === "zed_1")[0].extra.notes, "met at gym");
});

test("a header we do not recognise (older sheets) still reads by the standard positions; missing columns are not guessed", () => {
  const old = readSheets([{ name: "white_list", rows: [["username", "profile_link", "is_whitelisted", "is_deactivated", "new_username", "unfollowed", "is_deleted"], ["a1", "", "y", "", "", "", ""]] }]);
  assert.equal(old.accounts[0].isWhitelisted, true);
  assert.equal(old.accounts[0].lastChecked, ""); // the sheet has no last_checked column
  // a custom column sitting where last_checked would be is NOT read as a date
  const clash = readSheets([{ name: "white_list", rows: [["username", "is_whitelisted", "my_notes"], ["a1", "y", "2026-01-01 call"]] }]);
  assert.equal(clash.accounts[0].lastChecked, "");
  assert.equal(clash.accounts[0].extra.my_notes, "2026-01-01 call");
  assert.deepEqual(whiteListHeaderFor({ ...emptyData(), whiteListHeader: ["username", "my_notes"] }).slice(0, 2), ["username", "my_notes"]);
});

test("last_checked and check_result are read and written; typed Excel dates become ISO dates", () => {
  assert.equal(normalizeDate("46347"), "2026-11-21");
  assert.equal(normalizeDate("2026-11-21"), "2026-11-21");
  assert.equal(normalizeDate(undefined), "");
  const read = readSheets([{ name: "white_list", rows: [["username", "is_deactivated", "last_checked", "check_result"], ["a1", "y", "46347", "Unavailable"], ["b2", "", "", "banana"]] }]);
  assert.deepEqual([read.accounts[0].lastChecked, read.accounts[0].checkResult], ["2026-11-21", "unavailable"]);
  assert.equal(read.accounts[1].checkResult, "");
  const data = recordRecheck(setDeactivated(emptyData(), "x9", true), "x9", "unavailable", "2026-11-21");
  const row = writeSheets(data)[0].rows[1];
  assert.deepEqual(Array.from(row).slice(-2), ["2026-11-21", "unavailable"]);
});

// --- follower history: who unfollowed you -----------------------------------------------------

import { FollowerRecord, followersDate, latestSnapshotDate, mergeSnapshot } from "../src/offline/model";
import { generatedOnFromHtml } from "../src/offline/instagram-export";
import { SNAPSHOT_SHEET } from "../src/offline/workbook";

const rec = (username: string, firstSeen: string, lastSeen: string): FollowerRecord => ({ username, firstSeen, lastSeen });

test("the export's generation day is read from the HTML (<time datetime>); JSON has none", () => {
  assert.equal(generatedOnFromHtml(`<aside>Generated by me on <time datetime="2026-11-20T16:34Z">Friday</time></aside>`), "2026-11-20");
  assert.equal(generatedOnFromHtml("<html>no time here</html>"), undefined);
  const withTime = followersHtml.replace("<main>", `<main><time datetime="2026-11-20T16:34Z">x</time>`);
  assert.equal(parseInstagramExport(withTime, "followers_1.html").generatedOn, "2026-11-20");
  assert.equal(parseInstagramExport(followersFile, "followers_1.json").generatedOn, undefined);
});

test("first export: a baseline is created, nothing is reported as lost", () => {
  const result = mergeSnapshot([], ["Alice", "bob"], "2026-10-20");
  assert.equal(result.status, "baseline");
  assert.deepEqual(result.records, [rec("Alice", "2026-10-20", "2026-10-20"), rec("bob", "2026-10-20", "2026-10-20")]);
  assert.equal(result.previousDate, "");
});

test("a newer export: present followers are refreshed, new ones added, the missing keep their old lastSeen", () => {
  const history = [rec("alice", "2026-09-01", "2026-10-20"), rec("bob", "2026-09-01", "2026-10-20"), rec("carol", "2026-08-01", "2026-10-20")];
  const result = mergeSnapshot(history, ["ALICE", "dave"], "2026-11-20"); // bob and carol are gone, dave is new
  assert.equal(result.status, "updated");
  assert.equal(result.previousDate, "2026-10-20");
  const byName = (n: string) => result.records.filter(r => r.username === n)[0];
  assert.deepEqual(byName("alice"), rec("alice", "2026-09-01", "2026-11-20")); // case-insensitive match, keeps firstSeen
  assert.deepEqual(byName("bob"), rec("bob", "2026-09-01", "2026-10-20")); // unchanged: this is the proof
  assert.deepEqual(byName("dave"), rec("dave", "2026-11-20", "2026-11-20"));
});

test("loading the same export again changes nothing; loading an OLDER one is ignored", () => {
  const history = [rec("alice", "2026-09-01", "2026-11-20"), rec("bob", "2026-09-01", "2026-10-20")];
  const again = mergeSnapshot(history, ["alice"], "2026-11-20");
  assert.equal(again.status, "same");
  assert.deepEqual(again.records, history);
  const older = mergeSnapshot(history, ["alice", "bob", "zed"], "2026-10-01");
  assert.equal(older.status, "older");
  assert.deepEqual(older.records, history); // bob did not "re-follow", zed was not added
  assert.equal(latestSnapshotDate(history), "2026-11-20");
  assert.equal(mergeSnapshot(history, [], "2026-12-01").status, "none"); // no followers loaded: nothing to merge
});

test("followersDate: the newest 'generated on' of the loaded files, else the fallback day, else nothing", () => {
  const d = (files: { name: string; usernames: string[]; generatedOn?: string }[]): AppData => ({ ...emptyData(), followerFiles: files });
  assert.equal(followersDate(d([{ name: "a", usernames: [], generatedOn: "2026-10-01" }, { name: "b", usernames: [], generatedOn: "2026-11-01" }]), "2026-12-01"), "2026-11-01");
  assert.equal(followersDate(d([{ name: "a", usernames: [] }]), "2026-12-01"), "2026-12-01");
  assert.equal(followersDate(d([]), "2026-12-01"), "");
});

const historyData = (): AppData => {
  const base = baseData(); // following: alice carol dave_99 erin frank gina; followers: Alice, zed
  return {
    ...base,
    followerFiles: [{ name: "followers_1.html", usernames: ["alice", "zed", "newbie"], generatedOn: "2026-11-20" }],
    snapshots: [
      rec("alice", "2026-09-01", "2026-10-20"),
      rec("zed", "2026-09-01", "2026-10-20"),
      rec("lost_one", "2026-09-01", "2026-10-20"),
      rec("lost_two", "2026-09-01", "2026-10-20"),
      rec("lost_three", "2026-09-01", "2026-10-20"),
      rec("lost_four", "2026-09-01", "2026-10-20"),
      rec("old_loss", "2026-08-01", "2026-09-15"),
    ],
  };
};

test("analysis: new followers, lost followers and the ones still unexplained", () => {
  let data = historyData();
  data = setDeactivated(data, "lost_two", true); // explained: deactivated
  data = setNewUsername(data, "lost_three", "lost_three_new"); // explained: renamed
  const a = analyze(data);
  assert.equal(a.snapshot.status, "updated");
  assert.deepEqual(a.newFollowers, ["newbie"]);
  assert.deepEqual(a.lostFollowers.map(r => r.username).sort(), ["lost_four", "lost_one", "lost_three", "lost_two"]); // lost since the previous snapshot
  // pending = lost and not explained; the older loss is still listed, the most recent first
  assert.deepEqual(a.pendingUnfollowers.map(r => r.username), ["lost_four", "lost_one", "old_loss"]);
  assert.equal(a.pendingUnfollowers[0].note, "followed you until 2026-10-20");
});

test("the Unfollowed you list shows what you marked first, then the unexplained lost followers", () => {
  let data = historyData();
  data = setUnfollowedYou(data, "lost_one", true); // you confirmed this one
  const a = analyze(data);
  assert.deepEqual(a.unfollowedYou.map(r => r.username), ["lost_one", "lost_four", "lost_three", "lost_two", "old_loss"]);
  assert.ok(!a.pendingUnfollowers.some(r => r.username === "lost_one")); // confirmed ones are not pending
  assert.equal(a.unfollowedYou[0].note, "followed you until 2026-10-20");
});

test("recheck on a lost follower: the profile opens = unfollowed you, the page is gone = deactivated", () => {
  let data = historyData();
  data = recordRecheck(data, "lost_one", "works", "2026-11-21", "unfollower");
  data = recordRecheck(data, "lost_two", "unavailable", "2026-11-21", "unfollower");
  const get = (n: string) => data.accounts.filter(a => a.username === n)[0];
  assert.equal(get("lost_one").unfollowedYou, true);
  assert.equal(get("lost_one").isDeactivated, false);
  assert.equal(get("lost_two").isDeactivated, true);
  assert.equal(get("lost_two").unfollowedYou, false);
  const pending = analyze(data).pendingUnfollowers.map(r => r.username);
  assert.ok(!pending.includes("lost_one") && !pending.includes("lost_two")); // both are explained now
});

test("no history and no comparison are reported honestly", () => {
  assert.equal(analyze(baseData()).snapshot.status, "none");
  assert.deepEqual(analyze(baseData()).pendingUnfollowers, []);
  const first = analyze(baseData(), "2026-11-21"); // followers loaded, no date in the file: the fallback day is used
  assert.equal(first.snapshot.status, "baseline");
  assert.deepEqual(first.newFollowers, []); // nothing to compare with yet
  assert.deepEqual(first.lostFollowers, []);
});

test("the followers_snapshot sheet is written up to date, read back, and saving twice changes nothing", () => {
  const data = historyData();
  const sheets = writeSheets(data);
  const snap = sheets.filter(s => s.name === SNAPSHOT_SHEET)[0];
  assert.deepEqual(Array.from(snap.rows[0]), ["username", "profile_link", "first_seen", "last_seen"]);
  const byName = (n: string) => snap.rows.filter(r => r[0] === n)[0];
  assert.equal(byName("alice")[3], "2026-11-20"); // refreshed from the loaded export
  assert.equal(byName("lost_one")[3], "2026-10-20"); // the proof stays
  assert.equal(byName("newbie")[2], "2026-11-20"); // new follower
  const loaded = readWorkbook(writeWorkbook(data));
  assert.equal(loaded.snapshots.length, 8);
  // load the saved workbook with the same export again: same result
  const again = analyze({ ...historyData(), snapshots: loaded.snapshots });
  assert.equal(again.snapshot.status, "same");
  assert.deepEqual(again.pendingUnfollowers.map(r => r.username), ["lost_four", "lost_one", "lost_three", "lost_two", "old_loss"]);
});

test("snapshot rows: Excel day numbers are dates, unreadable rows are skipped, duplicates are ignored", () => {
  const read = readSheets([
    {
      name: "followers_snapshot",
      rows: [
        ["username", "profile_link", "first_seen", "last_seen"],
        ["a1", "", "46300", "2026-11-20"],
        ["a1", "", "2026-01-01", "2026-01-02"],
        ["b2", "", "not a date", "2026-11-20"],
        ["", "", "2026-01-01", "2026-01-02"],
      ],
    },
  ]);
  assert.deepEqual(read.snapshots, [rec("a1", "2026-10-05", "2026-11-20")]);
  assert.equal(read.skippedRows, 3);
});

test("the follower history survives the browser copy and junk is dropped", () => {
  const restored = sanitizeData(JSON.parse(JSON.stringify(historyData())));
  assert.equal(restored.snapshots.length, 7);
  assert.equal(restored.followerFiles[0].generatedOn, "2026-11-20");
  const junk = sanitizeData({
    snapshots: [rec("ok_user", "2026-01-01", "2026-02-01"), { username: "../x", firstSeen: "2026-01-01", lastSeen: "2026-01-01" }, { username: "fine", firstSeen: "yesterday", lastSeen: "2026-01-01" }, "nope"],
  });
  assert.deepEqual(junk.snapshots, [rec("ok_user", "2026-01-01", "2026-02-01")]);
});

// --- Instagram export ZIP ----------------------------------------------------

import { dayFromZipName, isZipName, readExportZip } from "../src/offline/export-zip";

const zipOf = (entries: Record<string, string>): Uint8Array => {
  const files: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(entries)) {
    files[name] = strToU8(text);
  }
  return zipSync(files);
};

test("zip: picks only following, followers and recently unfollowed, at any depth", () => {
  const folder = "connections/followers_and_following/";
  const zip = zipOf({
    [`${folder}following.html`]: "<a href=\"https://www.instagram.com/a\">a</a>",
    [`${folder}followers_1.html`]: "f1",
    [`${folder}followers_2.html`]: "f2",
    [`${folder}recently_unfollowed_profiles.html`]: "r",
    [`${folder}blocked_profiles.html`]: "no",
    [`${folder}pending_follow_requests.html`]: "no",
    [`${folder}close_friends.html`]: "no",
    "start_here.html": "no",
    "messages/inbox/following.html": "no",
    [`__MACOSX/${folder}followers_1.html`]: "no",
  });
  const result = readExportZip(zip, "instagram-user-2026-11-23-AbC.zip");
  assert.deepEqual(result.files.map(f => f.name), ["followers_1.html", "followers_2.html", "following.html", "recently_unfollowed_profiles.html"]);
  assert.equal(result.day, "2026-11-23");
  assert.equal(result.files[0].text, "f1");
});

test("zip: works with the older layout (a top folder) and JSON files", () => {
  const zip = zipOf({
    "instagram-user-2025-01-02/followers_and_following/followers_1.json": "[]",
    "instagram-user-2025-01-02/followers_and_following/following.json": "{}",
  });
  assert.deepEqual(readExportZip(zip).files.map(f => f.name), ["followers_1.json", "following.json"]);
});

test("zip: no list inside gives an empty result, not an error", () => {
  assert.equal(readExportZip(zipOf({ "start_here.html": "x" })).files.length, 0);
});

test("zip: a file that is not a zip is rejected with a clear message", () => {
  assert.throws(() => readExportZip(strToU8("not a zip at all")), /not a valid ZIP/);
});

test("zip: name helpers", () => {
  assert.equal(isZipName("Export.ZIP"), true);
  assert.equal(isZipName("following.html"), false);
  assert.equal(dayFromZipName("instagram-seasonsofninyo-2026-11-23-FIGdi2Oo.zip"), "2026-11-23");
  assert.equal(dayFromZipName("export.zip"), "");
});

test("zip: the parsed lists match the loose files", () => {
  const html = "<html><body><table><tr><td>Name</td><td>Username</td></tr></table><a href=\"https://www.instagram.com/alice\">alice</a><a href=\"https://www.instagram.com/bob\">bob</a></body></html>";
  const direct = parseInstagramExport(html, "following.html");
  const viaZip = readExportZip(zipOf({ "connections/followers_and_following/following.html": html })).files[0];
  assert.deepEqual(parseInstagramExport(viaZip.text, viaZip.name).usernames, direct.usernames);
});
