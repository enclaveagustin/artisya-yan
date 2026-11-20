import { isValidUsername } from "../utils/validation";

/**
 * The data the offline tool works with, and every rule for changing it. All
 * functions are pure (they return new objects) so they are easy to test and the
 * UI can never leave the data half-updated.
 */

export type RecheckResult = "unavailable" | "works";

export interface Account {
  readonly username: string;
  readonly isWhitelisted: boolean;
  readonly isDeactivated: boolean;
  /** The account's new handle if it was renamed; "" when not renamed. */
  readonly newUsername: string;
  /** Proven to have unfollowed YOU (tracking only; the "unfollowed" column of the sheet). */
  readonly unfollowedYou: boolean;
  /** The account was deleted (the "is_deleted" column). Instagram's own export also marks them, see isDeletedUsername. */
  readonly isDeleted: boolean;
  /** ISO date (YYYY-MM-DD) you last opened this profile to check it ("last_checked" column); "" if never. */
  readonly lastChecked: string;
  /** What you saw then ("check_result" column): unavailable = "Sorry, this page isn't available", works = it opened. */
  readonly checkResult: RecheckResult | "";
  /** Columns of your own in the white_list sheet (header -> text), kept untouched when the workbook is saved. */
  readonly extra: Readonly<Record<string, string>>;
}

export interface UnfollowedEntry {
  readonly username: string;
  /** ISO date (YYYY-MM-DD) the account was unfollowed. */
  readonly date: string;
}

export interface LoadedFile {
  readonly name: string;
  readonly usernames: readonly string[];
  /** Day (YYYY-MM-DD) the export was generated, when known. */
  readonly generatedOn?: string;
}

/**
 * One follower in the followers_snapshot sheet: the first and the last export you were seen in. A follower whose
 * lastSeen is older than the latest export is gone from your followers (unfollowed, deactivated, deleted, renamed or blocked).
 */
export interface FollowerRecord {
  readonly username: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

/** A sheet of your workbook that this tool does not manage, carried through a save as plain text. */
export interface RawSheet {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

export interface AppData {
  /** The white_list sheet: every account you keep notes on, in the order of the sheet. */
  readonly accounts: readonly Account[];
  /** The unfollowed sheet. */
  readonly unfollowed: readonly UnfollowedEntry[];
  readonly following: LoadedFile | null;
  readonly followerFiles: readonly LoadedFile[];
  /** recently_unfollowed_profiles.html: accounts YOU unfollowed, so a vanished account is not mistaken for a deleted one. */
  readonly recentlyUnfollowed: LoadedFile | null;
  /** The header row of your white_list sheet as you wrote it ([] = the standard one). Kept so a save does not reshuffle your columns. */
  readonly whiteListHeader: readonly string[];
  /** Other sheets of your workbook; written back after the managed ones. */
  readonly extraSheets: readonly RawSheet[];
  /** The followers_snapshot sheet as loaded (history of who followed you, see mergeSnapshot). */
  readonly snapshots: readonly FollowerRecord[];
}

/** How many profile tabs one recheck round can open (the page offers these sizes). */
export const RECHECK_BATCH_SIZES: readonly number[] = [5, 10, 20];
export const RECHECK_BATCH = RECHECK_BATCH_SIZES[0];

export const emptyData = (): AppData => ({
  accounts: [],
  unfollowed: [],
  following: null,
  followerFiles: [],
  recentlyUnfollowed: null,
  whiteListHeader: [],
  extraSheets: [],
  snapshots: [],
});

export const profileLink = (username: string): string => `https://www.instagram.com/${username}`;
export const key = (username: string): string => username.trim().toLowerCase();

const findAccount = (accounts: readonly Account[], username: string): Account | undefined => {
  const k = key(username);
  return accounts.filter(account => key(account.username) === k)[0];
};

const blankAccount = (username: string): Account => ({
  username,
  isWhitelisted: false,
  isDeactivated: false,
  newUsername: "",
  unfollowedYou: false,
  isDeleted: false,
  lastChecked: "",
  checkResult: "",
  extra: {},
});

/** An account row is worth keeping if it carries any flag, a check note, or text in one of your own columns. */
const hasNotes = (account: Account): boolean => {
  if (account.isWhitelisted || account.isDeactivated || account.newUsername !== "" || account.unfollowedYou || account.isDeleted) {
    return true;
  }
  if (account.lastChecked !== "" || account.checkResult !== "") {
    return true;
  }
  return Object.keys(account.extra).some(header => account.extra[header] !== "");
};

/**
 * Adds or replaces an account's notes. The account keeps its place in the sheet (a new one goes to the
 * end); a row left with nothing at all is dropped to keep the sheet tidy.
 */
function upsert(data: AppData, username: string, change: Partial<Omit<Account, "username">>): AppData {
  const existing = findAccount(data.accounts, username);
  const next: Account = { ...(existing ?? blankAccount(username)), ...change };
  if (existing === undefined) {
    return hasNotes(next) ? { ...data, accounts: [...data.accounts, next] } : data;
  }
  const k = key(username);
  const accounts: Account[] = [];
  for (const account of data.accounts) {
    if (key(account.username) !== k) {
      accounts.push(account);
    } else if (hasNotes(next)) {
      accounts.push(next);
    }
  }
  return { ...data, accounts };
}

export const setWhitelisted = (data: AppData, username: string, value: boolean): AppData =>
  upsert(data, username, { isWhitelisted: value });

export const setDeactivated = (data: AppData, username: string, value: boolean): AppData =>
  upsert(data, username, { isDeactivated: value });

export const setUnfollowedYou = (data: AppData, username: string, value: boolean): AppData =>
  upsert(data, username, { unfollowedYou: value });

export const setDeleted = (data: AppData, username: string, value: boolean): AppData =>
  upsert(data, username, { isDeleted: value });

/** Instagram's data export lists a deleted account as "__deleted__<random>". */
export const isDeletedUsername = (username: string): boolean => /^__deleted__/i.test(username);

/** An empty or invalid handle clears the rename. */
export const setNewUsername = (data: AppData, username: string, newUsername: string): AppData => {
  const cleaned = newUsername.trim().replace(/^@/, "");
  return upsert(data, username, { newUsername: isValidUsername(cleaned) ? cleaned : "" });
};

/**
 * Records what you saw when you opened the profile ("last_checked" / "check_result" in your sheet), and
 * keeps the deactivated mark in step with it: "works" clears the mark (the account is active),
 * "unavailable" sets it. That also covers a WHITELISTED account: being whitelisted says nothing about
 * whether it is still active, so it can be both whitelisted and deactivated. ("unavailable" is the same
 * message Instagram shows for deactivated, deleted, renamed and blocked accounts, so it proves the page
 * is gone, not why.)
 */
export const recordRecheck = (data: AppData, username: string, result: RecheckResult, date: string, mode: RecheckMode = "deactivated"): AppData => {
  if (mode === "unfollower") {
    // A follower who vanished from your list: if the profile opens, they really unfollowed you; if it is gone, it was deactivated.
    return upsert(data, username, {
      lastChecked: date,
      checkResult: result,
      unfollowedYou: result === "works",
      isDeactivated: result === "unavailable",
    });
  }
  return upsert(data, username, { lastChecked: date, checkResult: result, isDeactivated: result === "unavailable" });
};

/** deactivated: the Deactivated / Whitelisted tabs. unfollower: the Unfollowed you tab (the outcome means something else there). */
export type RecheckMode = "deactivated" | "unfollower";

/** Forgets every check note (the deactivated marks themselves stay). */
export const clearRechecks = (data: AppData): AppData => {
  const accounts: Account[] = [];
  for (const account of data.accounts) {
    const cleared: Account = { ...account, lastChecked: "", checkResult: "" };
    if (hasNotes(cleared)) {
      accounts.push(cleared);
    }
  }
  return { ...data, accounts };
};

export const hasRechecks = (data: AppData): boolean => data.accounts.some(account => account.lastChecked !== "");

export type RecheckOrder = "newest" | "oldest" | "az";

export interface RecheckOptions {
  /** Today as YYYY-MM-DD. */
  readonly today: string;
  /** An account checked fewer than this many days ago is not due; null = a check never expires. */
  readonly maxAgeDays: number | null;
  readonly order: RecheckOrder;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between two YYYY-MM-DD dates (Infinity if either one cannot be read). */
export function daysBetween(from: string, to: string): number {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(to);
  if (a === null || b === null) {
    return Infinity;
  }
  const ms = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) - Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  return Math.floor(ms / DAY_MS);
}

/**
 * The rows that are due for a recheck, in the chosen order. The export lists accounts newest follow
 * first, so "oldest" is that list reversed.
 */
export function recheckQueue(rows: readonly Row[], options: RecheckOptions): Row[] {
  const due = rows.filter(row => {
    const checked = row.account === undefined ? "" : row.account.lastChecked;
    if (checked === "") {
      return true;
    }
    return options.maxAgeDays !== null && daysBetween(checked, options.today) >= options.maxAgeDays;
  });
  if (options.order === "oldest") {
    return due.slice().reverse();
  }
  if (options.order === "az") {
    return due.slice().sort((a, b) => (key(a.username) < key(b.username) ? -1 : key(a.username) > key(b.username) ? 1 : 0));
  }
  return due;
}

export const markUnfollowed = (data: AppData, username: string, date: string): AppData => ({
  ...data,
  unfollowed: [
    ...data.unfollowed.filter(entry => key(entry.username) !== key(username)),
    { username, date },
  ],
});

export const undoUnfollowed = (data: AppData, username: string): AppData => ({
  ...data,
  unfollowed: data.unfollowed.filter(entry => key(entry.username) !== key(username)),
});

/** Same filename replaces that file; a different name adds another (followers_1, followers_2, ...). */
export const addFollowerFile = (data: AppData, file: LoadedFile): AppData => ({
  ...data,
  followerFiles: [...data.followerFiles.filter(existing => existing.name !== file.name), file],
});

export const setRecentlyUnfollowed = (data: AppData, file: LoadedFile | null): AppData => ({ ...data, recentlyUnfollowed: file });

export const removeFollowerFile = (data: AppData, name: string): AppData => ({
  ...data,
  followerFiles: data.followerFiles.filter(file => file.name !== name),
});

export type Bucket = "toReview" | "whitelisted" | "deleted" | "deactivated" | "renamed" | "unfollowed";

export interface Row {
  readonly username: string;
  readonly account: Account | undefined;
  readonly unfollowedOn: string;
  /** Extra line shown next to the account, e.g. "followed you until 2026-10-20". */
  readonly note?: string;
}

// --- follower history (who unfollowed you) ----------------------------------------------------

/** The newest date any follower was seen on ("" for no history). */
export const latestSnapshotDate = (records: readonly FollowerRecord[]): string =>
  records.reduce((latest, record) => (record.lastSeen > latest ? record.lastSeen : latest), "");

/** The date of the followers export in use: the newest "generated on" among the loaded files, else the fallback. */
export function followersDate(data: AppData, fallback: string): string {
  let best = "";
  for (const file of data.followerFiles) {
    if (file.generatedOn !== undefined && file.generatedOn > best) {
      best = file.generatedOn;
    }
  }
  return best !== "" ? best : data.followerFiles.length > 0 ? fallback : "";
}

export type SnapshotStatus =
  | "none" //     no followers loaded
  | "baseline" // first snapshot: nothing to compare with yet
  | "updated" //  a newer export than the last snapshot
  | "same" //     the export the sheet was last updated from
  | "older"; //   older than the last snapshot: not used

export interface SnapshotResult {
  readonly status: SnapshotStatus;
  readonly records: readonly FollowerRecord[];
  /** Date of the export in use ("" when none). */
  readonly date: string;
  /** The snapshot before this one: the newest older date in the history ("" when there is none). */
  readonly previousDate: string;
}

/**
 * Brings the follower history up to date with the loaded followers export (taken on `date`):
 * everyone in it gets lastSeen = date (new ones also firstSeen = date); the people who are not in it keep their old
 * lastSeen, which is what shows they are gone. An export older than the history is ignored, so loading an old file can
 * never make people look like they re-followed. Pure: the history in the data is not changed until a save writes it.
 */
export function mergeSnapshot(records: readonly FollowerRecord[], followers: readonly string[], date: string): SnapshotResult {
  const latest = latestSnapshotDate(records);
  if (date === "" || followers.length === 0) {
    return { status: "none", records, date: latest, previousDate: "" };
  }
  if (latest !== "" && date < latest) {
    return { status: "older", records, date: latest, previousDate: "" };
  }
  const present: Record<string, true> = {};
  for (const username of followers) {
    present[key(username)] = true;
  }
  const merged: FollowerRecord[] = [];
  const known: Record<string, true> = {};
  for (const record of records) {
    known[key(record.username)] = true;
    merged.push(present[key(record.username)] === true ? { ...record, lastSeen: date } : record);
  }
  for (const username of followers) {
    if (known[key(username)] !== true) {
      known[key(username)] = true;
      merged.push({ username, firstSeen: date, lastSeen: date });
    }
  }
  let previousDate = "";
  for (const record of merged) {
    if (record.lastSeen < date && record.lastSeen > previousDate) {
      previousDate = record.lastSeen;
    }
  }
  const status: SnapshotStatus = latest === "" ? "baseline" : latest === date ? "same" : "updated";
  return { status, records: merged, date, previousDate };
}

export interface Analysis {
  readonly followingCount: number;
  readonly followersCount: number;
  readonly mutualCount: number;
  readonly buckets: Record<Bucket, readonly Row[]>;
  /**
   * Accounts your sheet marks deactivated / deleted that FOLLOW YOU now. A deactivated or deleted
   * account cannot be in your followers list, so these are active again (or were marked by mistake).
   */
  readonly activeAgain: readonly Row[];
  /**
   * Accounts from your sheet that are gone from both lists although you did not unfollow them:
   * deleted (Instagram shows deleted accounts without their name) or renamed. Needs the following list.
   */
  readonly missing: readonly Row[];
  /** How many "__deleted__..." accounts Instagram lists in your following export (they carry no name). */
  readonly deletedInExport: number;
  /** The follower history brought up to date with the loaded export (this is what a save writes). */
  readonly snapshot: SnapshotResult;
  /** Followers first seen in the latest export (none on the first snapshot, there is nothing to compare with). */
  readonly newFollowers: readonly string[];
  /** Followers present in the previous snapshot and gone from this one, for whatever reason. */
  readonly lostFollowers: readonly FollowerRecord[];
  /** The "Unfollowed you" tab: accounts you marked, then lost followers nobody has explained yet. */
  readonly unfollowedYou: readonly Row[];
  /** The part of unfollowedYou that still needs a look (a lost follower is not always an unfollow: it may be deactivated, deleted, renamed or a block). */
  readonly pendingUnfollowers: readonly Row[];
}

/**
 * Compares who you follow with who follows you. Matching is case-insensitive.
 * For every account that does NOT follow you, in this order:
 *   already unfollowed -> unfollowed (its export is older than your unfollow)
 *   follows you under its new handle -> renamed (not a non-follower)
 *   whitelisted -> whitelisted
 *   deleted (marked, or "__deleted__..." in the export) -> deleted
 *   deactivated -> deactivated
 *   otherwise -> toReview
 */
export function analyze(data: AppData, fallbackDate: string = ""): Analysis {
  const followers: Record<string, true> = {};
  let followersCount = 0;
  for (const file of data.followerFiles) {
    for (const username of file.usernames) {
      if (followers[key(username)] !== true) {
        followers[key(username)] = true;
        followersCount++;
      }
    }
  }
  const unfollowedOn: Record<string, string> = {};
  for (const entry of data.unfollowed) {
    unfollowedOn[key(entry.username)] = entry.date;
  }

  const buckets: Record<Bucket, Row[]> = { toReview: [], whitelisted: [], deleted: [], deactivated: [], renamed: [], unfollowed: [] };
  const following = data.following === null ? [] : data.following.usernames;
  let mutualCount = 0;
  for (const username of following) {
    const k = key(username);
    if (followers[k] === true) {
      mutualCount++;
      continue;
    }
    const account = findAccount(data.accounts, username);
    const row: Row = { username, account, unfollowedOn: unfollowedOn[k] ?? "" };
    if (unfollowedOn[k] !== undefined) {
      buckets.unfollowed.push(row);
    } else if (account !== undefined && account.newUsername !== "" && followers[key(account.newUsername)] === true) {
      buckets.renamed.push(row);
    } else if (account !== undefined && account.isWhitelisted) {
      buckets.whitelisted.push(row);
    } else if (isDeletedUsername(username) || (account !== undefined && account.isDeleted)) {
      buckets.deleted.push(row);
    } else if (account !== undefined && account.isDeactivated) {
      buckets.deactivated.push(row);
    } else {
      buckets.toReview.push(row);
    }
  }
  const activeAgain: Row[] = [];
  const missing: Row[] = [];
  if (data.following !== null) {
    const inFollowing: Record<string, true> = {};
    for (const username of following) {
      inFollowing[key(username)] = true;
    }
    const youUnfollowed: Record<string, true> = {};
    for (const entry of data.unfollowed) {
      youUnfollowed[key(entry.username)] = true;
    }
    if (data.recentlyUnfollowed !== null) {
      for (const username of data.recentlyUnfollowed.usernames) {
        youUnfollowed[key(username)] = true;
      }
    }
    for (const account of data.accounts) {
      const k = key(account.username);
      const row: Row = { username: account.username, account, unfollowedOn: unfollowedOn[k] ?? "" };
      if ((account.isDeactivated || account.isDeleted) && followers[k] === true) {
        activeAgain.push(row);
      }
      const renamedTo = account.newUsername === "" ? "" : key(account.newUsername);
      const foundUnderNewName = renamedTo !== "" && (inFollowing[renamedTo] === true || followers[renamedTo] === true);
      if (inFollowing[k] !== true && followers[k] !== true && youUnfollowed[k] !== true && !account.isDeleted && !foundUnderNewName) {
        missing.push(row);
      }
    }
  }
  const deletedInExport = following.filter(isDeletedUsername).length;

  // Follower history: who was in the previous snapshot and is not in this one.
  const followerNames: string[] = [];
  const seenFollower: Record<string, true> = {};
  for (const file of data.followerFiles) {
    for (const username of file.usernames) {
      if (seenFollower[key(username)] !== true) {
        seenFollower[key(username)] = true;
        followerNames.push(username);
      }
    }
  }
  const snapshot = mergeSnapshot(data.snapshots, followerNames, followersDate(data, fallbackDate));
  const comparable = snapshot.status === "updated" || snapshot.status === "same";
  const gone = comparable ? snapshot.records.filter(record => record.lastSeen < snapshot.date) : [];
  const newFollowers = comparable && snapshot.previousDate !== "" ? snapshot.records.filter(record => record.firstSeen === snapshot.date).map(record => record.username) : [];
  const lostFollowers = gone.filter(record => record.lastSeen === snapshot.previousDate);
  const lastSeenOf: Record<string, string> = {};
  for (const record of snapshot.records) {
    lastSeenOf[key(record.username)] = record.lastSeen;
  }
  const confirmed: Row[] = data.accounts
    .filter(account => account.unfollowedYou)
    .map(account => ({
      username: account.username,
      account,
      unfollowedOn: "",
      note: lastSeenOf[key(account.username)] !== undefined && lastSeenOf[key(account.username)] < snapshot.date ? `followed you until ${lastSeenOf[key(account.username)]}` : undefined,
    }));
  const pendingUnfollowers: Row[] = [];
  for (const record of gone.slice().sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : key(a.username) < key(b.username) ? -1 : 1))) {
    const account = findAccount(data.accounts, record.username);
    const explained = account !== undefined && (account.unfollowedYou || account.isDeactivated || account.isDeleted || account.newUsername !== "");
    if (!explained) {
      pendingUnfollowers.push({ username: record.username, account, unfollowedOn: "", note: `followed you until ${record.lastSeen}` });
    }
  }
  return {
    followingCount: following.length,
    followersCount,
    mutualCount,
    buckets,
    activeAgain,
    missing,
    deletedInExport,
    snapshot,
    newFollowers,
    lostFollowers,
    unfollowedYou: [...confirmed, ...pendingUnfollowers],
    pendingUnfollowers,
  };
}

// --- restoring saved data -----------------------------------------------------
// The browser keeps a convenience copy of your work. Like any stored text it is
// treated as untrusted: it is rebuilt field by field and anything odd is dropped.

const MAX_TEXT = 2000;
const MAX_CELLS = 400000;
const MAX_HEADER_CELLS = 100;

const cleanUsernames = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && isValidUsername(item)) {
      out.push(item);
    }
  }
  return out;
};

const cleanFile = (raw: unknown): LoadedFile | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== "string") {
    return null;
  }
  const generatedOn = typeof record.generatedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.generatedOn) ? record.generatedOn : undefined;
  const base = { name: record.name.slice(0, 200), usernames: cleanUsernames(record.usernames) };
  return generatedOn === undefined ? base : { ...base, generatedOn };
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function cleanSnapshots(raw: unknown): FollowerRecord[] {
  const out: FollowerRecord[] = [];
  if (!Array.isArray(raw)) {
    return out;
  }
  const seen: Record<string, true> = {};
  for (const item of raw.slice(0, 200000)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.username !== "string" || !isValidUsername(r.username) || seen[key(r.username)] === true) {
      continue;
    }
    if (typeof r.firstSeen !== "string" || typeof r.lastSeen !== "string" || !ISO_DAY.test(r.firstSeen) || !ISO_DAY.test(r.lastSeen)) {
      continue;
    }
    seen[key(r.username)] = true;
    out.push({ username: r.username, firstSeen: r.firstSeen, lastSeen: r.lastSeen });
  }
  return out;
}

const cleanText = (value: unknown, max: number = MAX_TEXT): string => (typeof value === "string" ? value.slice(0, max) : "");

function cleanExtra(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return out;
  }
  const record = raw as Record<string, unknown>;
  let count = 0;
  for (const header of Object.keys(record)) {
    if (count >= MAX_HEADER_CELLS) {
      break;
    }
    if (header === "__proto__" || header === "constructor" || header === "prototype") {
      continue;
    }
    const value = cleanText(record[header]);
    if (value !== "") {
      out[header.slice(0, 200)] = value;
      count++;
    }
  }
  return out;
}

function cleanSheets(raw: unknown): RawSheet[] {
  const sheets: RawSheet[] = [];
  if (!Array.isArray(raw)) {
    return sheets;
  }
  let cells = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null || sheets.length >= 20) {
      continue;
    }
    const s = item as Record<string, unknown>;
    if (typeof s.name !== "string" || !Array.isArray(s.rows)) {
      continue;
    }
    const rows: string[][] = [];
    for (const row of s.rows) {
      if (!Array.isArray(row)) {
        continue;
      }
      const cleanRow = row.slice(0, 200).map(cell => cleanText(cell));
      cells += cleanRow.length;
      if (cells > MAX_CELLS) {
        break;
      }
      rows.push(cleanRow);
    }
    sheets.push({ name: s.name.slice(0, 31), rows });
  }
  return sheets;
}

export function sanitizeData(raw: unknown): AppData {
  if (typeof raw !== "object" || raw === null) {
    return emptyData();
  }
  const record = raw as Record<string, unknown>;
  const accounts: Account[] = [];
  if (Array.isArray(record.accounts)) {
    for (const item of record.accounts) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const a = item as Record<string, unknown>;
      if (typeof a.username !== "string" || !isValidUsername(a.username)) {
        continue;
      }
      accounts.push({
        username: a.username,
        isWhitelisted: a.isWhitelisted === true,
        isDeactivated: a.isDeactivated === true,
        newUsername: typeof a.newUsername === "string" && isValidUsername(a.newUsername) ? a.newUsername : "",
        unfollowedYou: a.unfollowedYou === true,
        isDeleted: a.isDeleted === true,
        lastChecked: cleanText(a.lastChecked, 20),
        checkResult: a.checkResult === "unavailable" || a.checkResult === "works" ? a.checkResult : "",
        extra: cleanExtra(a.extra),
      });
    }
  }
  // Older saved copies kept recheck results in a separate list; fold them into the accounts.
  if (Array.isArray(record.rechecks)) {
    for (const item of record.rechecks) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const c = item as Record<string, unknown>;
      if (typeof c.username !== "string" || (c.result !== "unavailable" && c.result !== "works")) {
        continue;
      }
      const index = accounts.map(a => key(a.username)).indexOf(key(c.username));
      if (index !== -1 && accounts[index].lastChecked === "") {
        accounts[index] = { ...accounts[index], lastChecked: cleanText(c.date, 20), checkResult: c.result };
      }
    }
  }
  const unfollowed: UnfollowedEntry[] = [];
  if (Array.isArray(record.unfollowed)) {
    for (const item of record.unfollowed) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const u = item as Record<string, unknown>;
      if (typeof u.username === "string" && isValidUsername(u.username)) {
        unfollowed.push({ username: u.username, date: typeof u.date === "string" ? u.date.slice(0, 20) : "" });
      }
    }
  }
  const followerFiles: LoadedFile[] = [];
  if (Array.isArray(record.followerFiles)) {
    for (const item of record.followerFiles) {
      const file = cleanFile(item);
      if (file !== null) {
        followerFiles.push(file);
      }
    }
  }
  const whiteListHeader = Array.isArray(record.whiteListHeader)
    ? record.whiteListHeader.slice(0, MAX_HEADER_CELLS).map(cell => cleanText(cell, 200))
    : [];
  return {
    accounts,
    unfollowed,
    following: cleanFile(record.following),
    followerFiles,
    recentlyUnfollowed: cleanFile(record.recentlyUnfollowed),
    whiteListHeader,
    extraSheets: cleanSheets(record.extraSheets),
    snapshots: cleanSnapshots(record.snapshots),
  };
}
