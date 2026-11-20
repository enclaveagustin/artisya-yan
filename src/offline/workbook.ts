import { isValidUsername } from "../utils/validation";
import { Account, AppData, FollowerRecord, RawSheet, UnfollowedEntry, analyze, key, profileLink } from "./model";
import { usernameFromHref } from "./instagram-export";
import { Sheet, readXlsx, writeXlsx } from "./xlsx";

/**
 * Maps the app's data to and from the base workbook (ig_whitelist.xlsx):
 *
 *   white_list               username | profile_link | is_whitelisted | is_deactivated | new_username | unfollowed | is_deleted | last_checked | check_result
 *   new_followingxfollowers  the standard columns: the accounts that do not follow you back (rewritten on every save)
 *   unfollowed               username | profile_link | unfollowed_on
 *
 * Flags are "y" (anything like y / yes / true / 1 / x is read as yes). The "unfollowed" column of
 * white_list marks an account that is proven to have unfollowed YOU (tracking). last_checked / check_result
 * hold the outcome of opening the profile by hand (see the recheck).
 *
 * Your workbook is yours: columns are found by their header name, so they can be in any order; columns of your
 * own and any other sheets are kept as plain text when you save, and your column order and row order are kept.
 * (Formulas, dates, colours and other formatting are not preserved.)
 */

export const WHITE_LIST_SHEET = "white_list";
export const RESULT_SHEET = "new_followingxfollowers";
export const UNFOLLOWED_SHEET = "unfollowed";

export const ACCOUNT_HEADER = [
  "username",
  "profile_link",
  "is_whitelisted",
  "is_deactivated",
  "new_username",
  "unfollowed",
  "is_deleted",
  "last_checked",
  "check_result",
];
export const UNFOLLOWED_HEADER = ["username", "profile_link", "unfollowed_on"];

/** Who has followed you, and in which exports (see mergeSnapshot): the proof behind "who unfollowed me". */
export const SNAPSHOT_SHEET = "followers_snapshot";
export const SNAPSHOT_HEADER = ["username", "profile_link", "first_seen", "last_seen"];

const isYes = (value: string | undefined): boolean => /^(y|yes|true|1|x|✓|✔)$/i.test((value ?? "").trim());

/** Excel stores a typed date as a day number (25569 = 1970-01-01); anything else is kept as written. */
export function normalizeDate(value: string | undefined): string {
  const text = (value ?? "").trim();
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const ms = Math.round((parseFloat(text) - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }
  return text.slice(0, 20);
}

/** Username from the username column, or recovered from the profile link column. */
function usernameFromRow(row: readonly string[], userCol: number, linkCol: number): string | null {
  const direct = (userCol < 0 ? "" : row[userCol] ?? "").trim().replace(/^@/, "");
  if (isValidUsername(direct)) {
    return direct;
  }
  return usernameFromHref((linkCol < 0 ? "" : row[linkCol] ?? "").trim());
}

const findSheet = (sheets: readonly Sheet[], name: string): Sheet | undefined => {
  const wanted = name.toLowerCase();
  return sheets.filter(sheet => sheet.name.trim().toLowerCase() === wanted)[0];
};

const MANAGED = [WHITE_LIST_SHEET, RESULT_SHEET, UNFOLLOWED_SHEET, SNAPSHOT_SHEET];
const isManaged = (name: string): boolean => MANAGED.indexOf(name.trim().toLowerCase()) !== -1;

const dataRows = (sheet: Sheet | undefined): readonly (readonly string[])[] => (sheet === undefined ? [] : sheet.rows.slice(1));

export interface WorkbookReadResult {
  readonly accounts: readonly Account[];
  readonly unfollowed: readonly UnfollowedEntry[];
  /** The followers_snapshot sheet (empty when the workbook has none yet). */
  readonly snapshots: readonly FollowerRecord[];
  /** The header row of your white_list sheet as written ([] when it had none we recognise). */
  readonly whiteListHeader: readonly string[];
  /** Sheets of your workbook that this tool does not manage. */
  readonly extraSheets: readonly RawSheet[];
  /** Headers of your own columns in white_list. */
  readonly extraColumns: readonly string[];
  /** Rows that had no usable username (skipped). */
  readonly skippedRows: number;
  readonly foundSheets: readonly string[];
}

export function dataFromSheets(sheets: readonly Sheet[]): WorkbookReadResult {
  const accounts: Account[] = [];
  const seen: Record<string, true> = {};
  let skippedRows = 0;
  const whiteList = findSheet(sheets, WHITE_LIST_SHEET);

  // Columns by header name. A header row we do not recognise falls back to the standard positions.
  const headerRow: readonly string[] = whiteList === undefined || whiteList.rows.length === 0 ? [] : whiteList.rows[0];
  const lowered = headerRow.map(cell => cell.trim().toLowerCase());
  const recognised = lowered.indexOf("username") !== -1 || lowered.indexOf("profile_link") !== -1;
  const standardNames = ACCOUNT_HEADER.map(name => name.toLowerCase());
  const col = (name: string): number => (recognised ? lowered.indexOf(name) : standardNames.indexOf(name));
  const at = (row: readonly string[], name: string): string | undefined => {
    const index = col(name);
    return index < 0 ? undefined : row[index];
  };

  const customColumns: { readonly index: number; readonly header: string }[] = [];
  if (recognised) {
    headerRow.forEach((cell, index) => {
      const header = cell.trim();
      if (header !== "" && standardNames.indexOf(header.toLowerCase()) === -1) {
        customColumns.push({ index, header });
      }
    });
  }

  for (const row of dataRows(whiteList)) {
    if (row.every(cell => cell.trim() === "")) {
      continue;
    }
    const username = usernameFromRow(row, col("username"), col("profile_link"));
    if (username === null || seen[key(username)] === true) {
      skippedRows++;
      continue;
    }
    seen[key(username)] = true;
    const rawNew = (at(row, "new_username") ?? "").trim().replace(/^@/, "");
    const result = (at(row, "check_result") ?? "").trim().toLowerCase();
    const extra: Record<string, string> = {};
    for (const custom of customColumns) {
      const value = (row[custom.index] ?? "").trim();
      if (value !== "") {
        extra[custom.header] = value;
      }
    }
    accounts.push({
      username,
      isWhitelisted: isYes(at(row, "is_whitelisted")),
      isDeactivated: isYes(at(row, "is_deactivated")),
      newUsername: isValidUsername(rawNew) ? rawNew : "",
      unfollowedYou: isYes(at(row, "unfollowed")),
      isDeleted: isYes(at(row, "is_deleted")),
      lastChecked: normalizeDate(at(row, "last_checked")),
      checkResult: result === "unavailable" || result === "works" ? result : "",
      extra,
    });
  }

  const unfollowed: UnfollowedEntry[] = [];
  const seenUnfollowed: Record<string, true> = {};
  for (const row of dataRows(findSheet(sheets, UNFOLLOWED_SHEET))) {
    if (row.every(cell => cell.trim() === "")) {
      continue;
    }
    const username = usernameFromRow(row, 0, 1);
    if (username === null || seenUnfollowed[key(username)] === true) {
      skippedRows++;
      continue;
    }
    seenUnfollowed[key(username)] = true;
    unfollowed.push({ username, date: normalizeDate(row[2]) });
  }

  // followers_snapshot: username | profile_link | first_seen | last_seen. Rows without two readable dates are skipped.
  const snapshots: FollowerRecord[] = [];
  const snapshotSheet = findSheet(sheets, SNAPSHOT_SHEET);
  if (snapshotSheet !== undefined && snapshotSheet.rows.length > 0) {
    const names = snapshotSheet.rows[0].map(cell => cell.trim().toLowerCase());
    const named = names.indexOf("username") !== -1 || names.indexOf("last_seen") !== -1;
    const colOf = (name: string, standard: number): number => (named ? names.indexOf(name) : standard);
    const seenSnapshot: Record<string, true> = {};
    for (const row of dataRows(snapshotSheet)) {
      if (row.every(cell => cell.trim() === "")) {
        continue;
      }
      const username = usernameFromRow(row, colOf("username", 0), colOf("profile_link", 1));
      const first = normalizeDate(colOf("first_seen", 2) < 0 ? undefined : row[colOf("first_seen", 2)]);
      const last = normalizeDate(colOf("last_seen", 3) < 0 ? undefined : row[colOf("last_seen", 3)]);
      if (username === null || !/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(last) || seenSnapshot[key(username)] === true) {
        skippedRows++;
        continue;
      }
      seenSnapshot[key(username)] = true;
      snapshots.push({ username, firstSeen: first, lastSeen: last });
    }
  }

  // Header as written, without trailing blank cells.
  const trimmedHeader = headerRow.map(cell => cell.trim());
  while (trimmedHeader.length > 0 && trimmedHeader[trimmedHeader.length - 1] === "") {
    trimmedHeader.pop();
  }
  const extraSheets: RawSheet[] = sheets.filter(sheet => !isManaged(sheet.name)).map(sheet => ({ name: sheet.name, rows: sheet.rows }));
  return {
    accounts,
    unfollowed,
    snapshots,
    whiteListHeader: recognised ? trimmedHeader : [],
    extraSheets,
    extraColumns: customColumns.map(custom => custom.header),
    skippedRows,
    foundSheets: sheets.map(sheet => sheet.name),
  };
}

const flag = (value: boolean): string => (value ? "y" : "");

/** The header written to white_list: yours as it was, plus any standard column it lacked. */
export function whiteListHeaderFor(data: AppData): string[] {
  if (data.whiteListHeader.length === 0) {
    return ACCOUNT_HEADER.slice();
  }
  const have = data.whiteListHeader.map(cell => cell.trim().toLowerCase());
  return [...data.whiteListHeader, ...ACCOUNT_HEADER.filter(name => have.indexOf(name) === -1)];
}

function accountCells(account: Account, header: readonly string[]): string[] {
  return header.map(cell => {
    const name = cell.trim();
    switch (name.toLowerCase()) {
      case "username": return account.username;
      case "profile_link": return profileLink(account.username);
      case "is_whitelisted": return flag(account.isWhitelisted);
      case "is_deactivated": return flag(account.isDeactivated);
      case "new_username": return account.newUsername;
      case "unfollowed": return flag(account.unfollowedYou);
      case "is_deleted": return flag(account.isDeleted);
      case "last_checked": return account.lastChecked;
      case "check_result": return account.checkResult;
      default: return name === "" ? "" : account.extra[name] ?? "";
    }
  });
}

/** `fallbackDate` (today) dates a followers export that does not say when it was generated (the JSON one). */
export function sheetsFromData(data: AppData, fallbackDate: string = ""): Sheet[] {
  const bySheetOrder = (a: string, b: string): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const header = whiteListHeaderFor(data);
  const analysis = analyze(data, fallbackDate);
  const reviewRows = analysis.buckets.toReview.map(row =>
    accountCells(
      row.account ?? {
        username: row.username,
        isWhitelisted: false,
        isDeactivated: false,
        newUsername: "",
        unfollowedYou: false,
        isDeleted: false,
        lastChecked: "",
        checkResult: "",
        extra: {},
      },
      ACCOUNT_HEADER,
    ),
  );
  const managed: Sheet[] = [
    // Your accounts stay in the order of your sheet; new ones are added at the end.
    { name: WHITE_LIST_SHEET, rows: [header, ...data.accounts.map(account => accountCells(account, header))] },
    { name: RESULT_SHEET, rows: [ACCOUNT_HEADER, ...reviewRows.sort((a, b) => bySheetOrder(a[0], b[0]))] },
    {
      name: UNFOLLOWED_SHEET,
      rows: [UNFOLLOWED_HEADER, ...data.unfollowed.map(entry => [entry.username, profileLink(entry.username), entry.date])],
    },
    // The history is written back up to date with the followers export that is loaded.
    {
      name: SNAPSHOT_SHEET,
      rows: [SNAPSHOT_HEADER, ...analysis.snapshot.records.map(record => [record.username, profileLink(record.username), record.firstSeen, record.lastSeen])],
    },
  ];
  return [...managed, ...data.extraSheets.filter(sheet => !isManaged(sheet.name))];
}

export const writeWorkbook = (data: AppData, fallbackDate: string = ""): Uint8Array => writeXlsx(sheetsFromData(data, fallbackDate));

export function readWorkbook(bytes: Uint8Array): WorkbookReadResult {
  const result = dataFromSheets(readXlsx(bytes));
  const lower = result.foundSheets.map(name => name.trim().toLowerCase());
  if (lower.indexOf(WHITE_LIST_SHEET) === -1 && lower.indexOf(UNFOLLOWED_SHEET) === -1) {
    throw new Error(`This workbook has no "${WHITE_LIST_SHEET}" or "${UNFOLLOWED_SHEET}" sheet. Sheets found: ${result.foundSheets.join(", ") || "none"}.`);
  }
  return result;
}
