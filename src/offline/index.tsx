import React, { useEffect, useRef, useState } from "react";
import { render } from "react-dom";
import "./offline.scss";

import { parseInstagramExport } from "./instagram-export";
import { PROFILE_IMAGE } from "./profile-image";

const APP_NAME = "Artisya Yan?!";
const AUTHOR_NAME = "Niño D. Agustin";
import {
  Analysis,
  AppData,
  Bucket,
  RECHECK_BATCH_SIZES,
  RecheckMode,
  RecheckOrder,
  Row,
  addFollowerFile,
  analyze,
  clearRechecks,
  emptyData,
  followersDate,
  hasRechecks,
  recheckQueue,
  recordRecheck,
  key,
  isDeletedUsername,
  markUnfollowed,
  profileLink,
  removeFollowerFile,
  sanitizeData,
  setDeactivated,
  setDeleted,
  setNewUsername,
  setRecentlyUnfollowed,
  setUnfollowedYou,
  setWhitelisted,
  undoUnfollowed,
} from "./model";
import { readWorkbook, writeWorkbook } from "./workbook";

const STORAGE_KEY = "igo_state_v1";
const PAGE_SIZE = 100;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type TabId = Bucket | "unfollowedYou" | "activeAgain" | "missing";
type Notice = { readonly kind: "ok" | "error"; readonly text: string };

const TABS: readonly { readonly id: TabId; readonly label: string; readonly hint: string }[] = [
  { id: "toReview", label: "To review", hint: "Follow you less than you follow them: decide on each one." },
  { id: "whitelisted", label: "Whitelisted", hint: "Protected: kept even though they do not follow back." },
  { id: "deleted", label: "Deleted", hint: "Accounts Instagram lists as deleted (their name starts with __deleted__) or that you marked is_deleted." },
  { id: "deactivated", label: "Deactivated", hint: "Accounts marked as deactivated. Press View to check one: if its profile opens again it is active, so clear the mark." },
  { id: "activeAgain", label: "Active again", hint: "Marked deactivated or deleted in your sheet, but they follow you now. A deactivated or deleted account cannot be a follower, so it is back (or the mark was a mistake). Press View to confirm, then clear the mark." },
  { id: "missing", label: "Missing", hint: "In your sheet, but gone from your following and followers lists, and you did not unfollow them: most likely deleted (Instagram lists deleted accounts without a name) or renamed." },
  { id: "renamed", label: "Renamed", hint: "Follow you under a new username, so they are not non-followers." },
  { id: "unfollowed", label: "Unfollowed", hint: "Your log of accounts you already unfollowed." },
  { id: "unfollowedYou", label: "Unfollowed you", hint: "Accounts you marked as having unfollowed you (the \"unfollowed\" column), plus followers who were in your last snapshot and are gone now. A lost follower is not always an unfollow: the account may have been deactivated, deleted, renamed or have blocked you. Open the profile to tell." },
];

interface RecheckSettings {
  readonly batchSize: number;
  /** null = a check never expires. */
  readonly maxAgeDays: number | null;
  readonly order: RecheckOrder;
}

const RECHECK_SETTINGS_KEY = "igo_recheck_settings_v1";
const DEFAULT_RECHECK_SETTINGS: RecheckSettings = { batchSize: RECHECK_BATCH_SIZES[0], maxAgeDays: 90, order: "newest" };

/** One line under the numbers that says what the follower history did with this export. */
function historyLine(analysis: Analysis, loadedDay: string): string {
  const { snapshot } = analysis;
  switch (snapshot.status) {
    case "baseline":
      return `Follower tracking started with this export (${snapshot.date}). Save the workbook and load a newer export next time: the page then shows who unfollowed you.`;
    case "older":
      return `This followers export (${loadedDay}) is older than your last snapshot (${snapshot.date}), so it is not used for tracking.`;
    case "updated":
    case "same":
      return snapshot.previousDate === ""
        ? `Follower history: ${snapshot.records.length} accounts, latest export ${snapshot.date}.`
        : `Compared with your snapshot of ${snapshot.previousDate}: ${analysis.newFollowers.length} new follower${analysis.newFollowers.length === 1 ? "" : "s"}, ${analysis.lostFollowers.length} lost. ` +
            `${analysis.pendingUnfollowers.length} lost follower${analysis.pendingUnfollowers.length === 1 ? "" : "s"} still to check in the Unfollowed you tab.`;
    default:
      return snapshot.records.length > 0
        ? `Your workbook has a follower history up to ${snapshot.date}. Load followers_1.html to compare.`
        : "Load followers_1.html to start tracking who follows and unfollows you.";
  }
}

function loadRecheckSettings(): RecheckSettings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECHECK_SETTINGS_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) {
      return DEFAULT_RECHECK_SETTINGS;
    }
    const r = raw as Record<string, unknown>;
    return {
      batchSize: RECHECK_BATCH_SIZES.indexOf(r.batchSize as number) !== -1 ? (r.batchSize as number) : DEFAULT_RECHECK_SETTINGS.batchSize,
      maxAgeDays: r.maxAgeDays === null ? null : [30, 90, 180].indexOf(r.maxAgeDays as number) !== -1 ? (r.maxAgeDays as number) : DEFAULT_RECHECK_SETTINGS.maxAgeDays,
      order: r.order === "oldest" || r.order === "az" || r.order === "newest" ? r.order : DEFAULT_RECHECK_SETTINGS.order,
    };
  } catch {
    return DEFAULT_RECHECK_SETTINGS;
  }
}

function saveRecheckSettings(settings: RecheckSettings): void {
  try {
    localStorage.setItem(RECHECK_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not saved: the page just uses the defaults next time.
  }
}

function loadSaved(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? emptyData() : sanitizeData(JSON.parse(raw));
  } catch {
    return emptyData();
  }
}

function persist(data: AppData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked: the workbook you save is the real copy anyway.
  }
}

const today = (): string => {
  const d = new Date();
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function download(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: XLSX_TYPE });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const Stat = ({ label, value }: { readonly label: string; readonly value: number | string }) => (
  <div className="stat">
    <strong>{value}</strong>
    <span>{label}</span>
  </div>
);

interface RowViewProps {
  readonly row: Row;
  readonly tab: TabId;
  readonly onChange: (change: (data: AppData) => AppData) => void;
}

const RowView = ({ row, tab, onChange }: RowViewProps) => {
  const name = row.username;
  const account = row.account;
  const askRename = () => {
    const answer = window.prompt(`New username for @${name} (leave empty to clear):`, account !== undefined ? account.newUsername : "");
    if (answer !== null) {
      onChange(data => setNewUsername(data, name, answer));
    }
  };
  return (
    <li className="row">
      <div className="who">
        <strong className="handle">@{name}</strong>
        <span className="tags">
          {account !== undefined && account.isWhitelisted && <em className="tag ok">whitelisted</em>}
          {(isDeletedUsername(name) || (account !== undefined && account.isDeleted)) && <em className="tag warn">deleted</em>}
          {account !== undefined && account.isDeactivated && <em className="tag warn">deactivated</em>}
          {account !== undefined && account.unfollowedYou && <em className="tag warn">unfollowed you</em>}
          {account !== undefined && account.newUsername !== "" && (
            <em className="tag info">
              now{" "}
              <a href={profileLink(account.newUsername)} target="_blank" rel="noopener noreferrer">
                @{account.newUsername}
              </a>
            </em>
          )}
          {row.unfollowedOn !== "" && <em className="tag">unfollowed {row.unfollowedOn}</em>}
          {row.note !== undefined && <em className="tag info">{row.note}</em>}
          {account !== undefined && account.checkResult !== "" && (
            <em className={account.checkResult === "works" ? "tag ok" : "tag"}>
              {account.checkResult === "works" ? "works" : "page unavailable"} {account.lastChecked}
            </em>
          )}
        </span>
      </div>
      <div className="actions">
        {!isDeletedUsername(name) && (
          <a className="button view" href={profileLink(name)} target="_blank" rel="noopener noreferrer">View ↗</a>
        )}
        {tab === "activeAgain" && (
          <button type="button" className="primary" onClick={() => onChange(d => setDeleted(setDeactivated(d, name, false), name, false))}>
            Clear mark
          </button>
        )}
        {tab === "missing" && (
          <>
            <button type="button" onClick={() => onChange(d => setDeleted(d, name, true))}>Mark deleted</button>
            <button type="button" onClick={askRename}>Renamed…</button>
            <button type="button" className="primary" onClick={() => onChange(d => markUnfollowed(d, name, today()))}>Unfollowed ✓</button>
          </>
        )}
        {tab === "toReview" && (
          <>
            <button type="button" onClick={() => onChange(d => setWhitelisted(d, name, true))}>Whitelist</button>
            <button type="button" onClick={() => onChange(d => setDeactivated(d, name, true))}>Deactivated</button>
            <button type="button" onClick={() => onChange(d => setDeleted(d, name, true))}>Deleted</button>
            <button type="button" onClick={askRename}>Renamed…</button>
            <button type="button" onClick={() => onChange(d => setUnfollowedYou(d, name, true))}>They unfollowed me</button>
            <button type="button" className="primary" onClick={() => onChange(d => markUnfollowed(d, name, today()))}>Unfollowed ✓</button>
          </>
        )}
        {tab === "unfollowedYou" && account !== undefined && account.unfollowedYou && (
          <button type="button" onClick={() => onChange(d => setUnfollowedYou(d, name, false))}>Clear</button>
        )}
        {tab === "unfollowedYou" && (account === undefined || !account.unfollowedYou) && (
          <>
            <button type="button" className="primary" onClick={() => onChange(d => setUnfollowedYou(d, name, true))}>They unfollowed me</button>
            <button type="button" onClick={() => onChange(d => setDeactivated(d, name, true))}>Deactivated</button>
            <button type="button" onClick={() => onChange(d => setDeleted(d, name, true))}>Deleted</button>
            <button type="button" onClick={askRename}>Renamed…</button>
          </>
        )}
        {tab === "whitelisted" && (
          <button type="button" onClick={() => onChange(d => setWhitelisted(d, name, false))}>Remove from whitelist</button>
        )}
        {tab === "deleted" && (
          <>
            {account !== undefined && account.isDeleted && (
              <button type="button" onClick={() => onChange(d => setDeleted(d, name, false))}>Not deleted</button>
            )}
            <button type="button" className="primary" onClick={() => onChange(d => markUnfollowed(d, name, today()))}>Unfollowed ✓</button>
          </>
        )}
        {tab === "deactivated" && (
          <>
            <button type="button" onClick={() => onChange(d => setDeactivated(d, name, false))}>Not deactivated</button>
            <button type="button" className="primary" onClick={() => onChange(d => markUnfollowed(d, name, today()))}>Unfollowed ✓</button>
          </>
        )}
        {tab === "renamed" && (
          <button type="button" onClick={() => onChange(d => setNewUsername(d, name, ""))}>Clear rename</button>
        )}
        {tab === "unfollowed" && (
          <button type="button" onClick={() => onChange(d => undoUnfollowed(d, name))}>Undo</button>
        )}
      </div>
    </li>
  );
};

const App = () => {
  const [data, setData] = useState<AppData>(() => loadSaved());
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [batch, setBatch] = useState<string[]>([]);
  const [tab, setTab] = useState<TabId>("toReview");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    persist(data);
  }, [data]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (fn: (data: AppData) => AppData) => {
    setData(prev => fn(prev));
    setDirty(true);
  };

  const analysis: Analysis = analyze(data, today());

  // --- recheck of "deactivated" accounts: open the profiles, you look, you press a button ---
  const [recheckSettings, setRecheckSettings] = useState<RecheckSettings>(() => loadRecheckSettings());
  const changeRecheckSettings = (patch: Partial<RecheckSettings>) => {
    setRecheckSettings(prev => {
      const next = { ...prev, ...patch };
      saveRecheckSettings(next);
      return next;
    });
  };
  // The same recheck works on the Deactivated tab and on the Whitelisted tab: a whitelisted account can be deactivated too.
  // On the "Unfollowed you" tab the same recheck settles a lost follower: if the profile opens they unfollowed you, if it is gone it was deactivated.
  const recheckMode: RecheckMode = tab === "unfollowedYou" ? "unfollower" : "deactivated";
  const recheckRows =
    tab === "unfollowedYou" ? analysis.pendingUnfollowers : tab === "whitelisted" ? analysis.buckets.whitelisted : analysis.buckets.deactivated;
  const recheckTodo = recheckQueue(recheckRows, { today: today(), maxAgeDays: recheckSettings.maxAgeDays, order: recheckSettings.order });
  const whitelistedAndDeactivated = analysis.buckets.whitelisted.filter(row => row.account !== undefined && row.account.isDeactivated).length;

  const openRecheckBatch = () => {
    const next = recheckTodo.slice(0, recheckSettings.batchSize).map(row => row.username);
    const opened: string[] = [];
    for (const name of next) {
      // No "noopener" feature here: that would hide whether the browser blocked the tab.
      const tabWindow = window.open(profileLink(name), "_blank");
      if (tabWindow === null) {
        continue;
      }
      try {
        tabWindow.opener = null; // the Instagram tab gets no handle back to this page
      } catch {
        // Not allowed in this browser: harmless.
      }
      opened.push(name);
    }
    setBatch(opened);
    if (opened.length < next.length) {
      setNotice({
        kind: "error",
        text: `${next.length - opened.length} of ${next.length} tabs were blocked by your browser. Allow pop-ups for this page and press the button again, or use the Open buttons below.`,
      });
      if (opened.length === 0) {
        setBatch(next); // still list them so the Open links can be used one by one
      }
    }
  };

  const decide = (name: string, result: "unavailable" | "works") => {
    change(d => recordRecheck(d, name, result, today(), recheckMode));
    setBatch(prev => prev.filter(n => n !== name));
  };

  // Keyboard: with a batch open, U = unavailable and W = works for the first account in the list (the order the
  // tabs were opened in), A = all unavailable. Ignored while you type in a field.
  useEffect(() => {
    if (batch.length === 0) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target === null ? "" : target.tagName;
      if (e.ctrlKey || e.metaKey || e.altKey || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "u" || k === "w") {
        e.preventDefault();
        decide(batch[0], k === "u" ? "unavailable" : "works");
      } else if (k === "a") {
        e.preventDefault();
        batch.slice().forEach(name => decide(name, "unavailable"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The unfollowed tab shows the whole log, including accounts that are no
  // longer in the (older) following export.
  const tabRows = (id: TabId): readonly Row[] =>
    id === "unfollowed"
      ? data.unfollowed.map(entry => ({ username: entry.username, account: undefined, unfollowedOn: entry.date }))
      : id === "unfollowedYou"
      ? analysis.unfollowedYou
      : id === "activeAgain"
      ? analysis.activeAgain
      : id === "missing"
      ? analysis.missing
      : analysis.buckets[id];

  const handleFiles = async (files: readonly File[]) => {
    const messages: string[] = [];
    let failed = false;
    for (const file of files) {
      let exportDay = "";
      try {
        if (/\.xlsx$/i.test(file.name)) {
          const result = readWorkbook(new Uint8Array(await file.arrayBuffer()));
          setData(prev => ({
            ...prev,
            accounts: result.accounts,
            unfollowed: result.unfollowed,
            whiteListHeader: result.whiteListHeader,
            extraSheets: result.extraSheets,
            snapshots: result.snapshots,
          }));
          setDirty(false);
          const kept: string[] = [];
          if (result.extraColumns.length > 0) {
            kept.push(`${result.extraColumns.length} column${result.extraColumns.length === 1 ? "" : "s"} of your own (${result.extraColumns.join(", ")})`);
          }
          if (result.extraSheets.length > 0) {
            kept.push(`${result.extraSheets.length} other sheet${result.extraSheets.length === 1 ? "" : "s"} (${result.extraSheets.map(sheet => sheet.name).join(", ")})`);
          }
          messages.push(
            `${file.name}: loaded ${result.accounts.length} accounts and ${result.unfollowed.length} unfollowed` +
              (result.skippedRows > 0 ? ` (${result.skippedRows} rows skipped)` : "") +
              (kept.length > 0 ? `; kept as they are: ${kept.join(" and ")}` : "") +
              (result.snapshots.length > 0 ? `; follower history of ${result.snapshots.length} accounts` : ""),
          );
        } else if (/\.(json|html?)$/i.test(file.name)) {
          const result = parseInstagramExport(await file.text(), file.name);
          if (result.kind === "following") {
            setData(prev => ({ ...prev, following: { name: file.name, usernames: result.usernames } }));
          } else if (result.kind === "followers") {
            // The HTML export says when it was generated; for a file that does not, its last-modified day is the best guess.
            exportDay = result.generatedOn ?? new Date(file.lastModified).toISOString().slice(0, 10);
            const day = exportDay;
            setData(prev => addFollowerFile(prev, { name: file.name, usernames: result.usernames, generatedOn: day }));
          } else if (result.kind === "recentlyUnfollowed") {
            setData(prev => setRecentlyUnfollowed(prev, { name: file.name, usernames: result.usernames }));
          } else if (result.kind === "other") {
            messages.push(`${file.name}: not needed (${result.usernames.length} accounts), ignored`);
            continue;
          } else {
            throw new Error("Could not tell whether this is your following or your followers list. Keep \"following\" or \"followers\" in the file name.");
          }
          messages.push(
            `${file.name}: ${result.usernames.length} ${result.kind === "recentlyUnfollowed" ? "unfollowed by you" : result.kind}` +
              (exportDay !== "" ? ` (export of ${exportDay})` : "") +
              (result.skipped > 0 ? ` (${result.skipped} entries skipped)` : ""),
          );
        } else {
          throw new Error("Only .html / .json (Instagram export) and .xlsx (workbook) files are supported.");
        }
      } catch (e) {
        failed = true;
        messages.push(`${file.name}: ${e instanceof Error ? e.message : "could not be read"}`);
      }
    }
    setPage(1);
    setNotice({ kind: failed ? "error" : "ok", text: messages.join("\n") });
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    if (files !== null && files.length > 0) {
      void handleFiles(Array.from(files));
    }
    e.currentTarget.value = "";
  };

  const onDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer !== null ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) {
      void handleFiles(files);
    }
  };

  const saveWorkbook = () => {
    download(writeWorkbook(data, today()), "ig_whitelist.xlsx");
    setDirty(false);
    setNotice({ kind: "ok", text: "Saved ig_whitelist.xlsx to your downloads. Keep it: it is your database." });
  };

  const resetAll = () => {
    if (window.confirm("Clear everything this page remembers (whitelist, unfollowed log, loaded lists)? Your saved .xlsx files are not touched.")) {
      setData(emptyData());
      setDirty(false);
      setNotice({ kind: "ok", text: "Cleared." });
    }
  };

  const needle = query.trim().toLowerCase().replace(/^@/, "");
  const allRows = tabRows(tab);
  const rows = allRows.filter(row => needle === "" || key(row.username).indexOf(needle) !== -1 || (row.account !== undefined && key(row.account.newUsername).indexOf(needle) !== -1));
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const haveLists = data.following !== null && data.followerFiles.length > 0;
  const activeTab = TABS.filter(t => t.id === tab)[0];

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img className="avatar" src={PROFILE_IMAGE} alt={AUTHOR_NAME} width={72} height={72} />
          <div>
            <h1>{APP_NAME}</h1>
            <p className="byline">Follow-back checker · by {AUTHOR_NAME}</p>
            <p className="sub">
              <span className="badge">Offline</span> Nothing is uploaded or sent anywhere. Your files are read inside this page only.
            </p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" className="primary" onClick={saveWorkbook}>
            Save workbook (.xlsx){dirty ? " •" : ""}
          </button>
        </div>
      </header>

      <section
        className={`drop${dragging ? " over" : ""}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div>
          <h2>1. Add your files</h2>
          <p>
            Drop them here, or{" "}
            <button type="button" className="link" onClick={() => fileInput.current !== null && fileInput.current.click()}>choose files</button>.
            You can select several at once.
          </p>
          <ul className="needs">
            <li><b>following.html</b> and <b>followers_1.html</b> (+ followers_2.html …) from Instagram's "Download your information". The JSON versions work too. Add <b>recently_unfollowed_profiles.html</b> as well to tell deleted accounts from ones you unfollowed.</li>
            <li><b>ig_whitelist.xlsx</b> <em>(optional)</em>: your saved workbook with the white_list and unfollowed tabs.</li>
          </ul>
          <input ref={fileInput} type="file" accept=".html,.htm,.json,.xlsx" multiple hidden onChange={onPick} />
        </div>
        <div className="loaded">
          <h3>Loaded</h3>
          <ul>
            <li className={data.following !== null ? "yes" : "no"}>
              {data.following !== null ? `✓ ${data.following.name}: ${data.following.usernames.length} following` : "○ following: not loaded"}
            </li>
            {data.followerFiles.map(file => (
              <li key={file.name} className="yes">
                ✓ {file.name}: {file.usernames.length} followers{" "}
                <button type="button" className="link" onClick={() => change(d => removeFollowerFile(d, file.name))}>remove</button>
              </li>
            ))}
            {data.followerFiles.length === 0 && <li className="no">○ followers: not loaded</li>}
            <li className={data.recentlyUnfollowed !== null ? "yes" : "no"}>
              {data.recentlyUnfollowed !== null
                ? `✓ ${data.recentlyUnfollowed.name}: ${data.recentlyUnfollowed.usernames.length} unfollowed by you`
                : "○ recently_unfollowed_profiles.html: optional (helps tell deleted from unfollowed)"}
            </li>
            <li className={data.accounts.length + data.unfollowed.length > 0 ? "yes" : "no"}>
              {data.accounts.length + data.unfollowed.length > 0
                ? `✓ workbook: ${data.accounts.length} accounts, ${data.unfollowed.length} unfollowed`
                : "○ workbook: empty (optional)"}
            </li>
          </ul>
          <p className="small">
            <button type="button" className="link" onClick={() => download(writeWorkbook(emptyData()), "ig_whitelist_blank.xlsx")}>Download a blank workbook</button>
            {" · "}
            <button type="button" className="link" onClick={resetAll}>Clear everything</button>
          </p>
        </div>
      </section>

      {notice !== null && (
        <pre className={`notice ${notice.kind}`} role="status">{notice.text}</pre>
      )}

      {haveLists && (
        <>
          <section className="stats">
            <Stat label="You follow" value={analysis.followingCount} />
            <Stat label="Follow you" value={analysis.followersCount} />
            <Stat label="Follow back" value={analysis.mutualCount} />
            <Stat label="To review" value={analysis.buckets.toReview.length} />
            <Stat label="Whitelisted" value={analysis.buckets.whitelisted.length} />
            {analysis.snapshot.previousDate !== "" && <Stat label="New followers" value={analysis.newFollowers.length} />}
            {analysis.snapshot.previousDate !== "" && <Stat label="Lost followers" value={analysis.lostFollowers.length} />}
          </section>
          <p className="history small">{historyLine(analysis, followersDate(data, today()))}</p>

          <section className="results">
            <h2>2. Review who does not follow back</h2>
            <nav className="tabs" role="tablist">
              {TABS.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={tab === t.id ? "tab active" : "tab"}
                  onClick={() => { setTab(t.id); setPage(1); }}
                >
                  {t.label} <span className="count">{tabRows(t.id).length}</span>
                </button>
              ))}
            </nav>
            <p className="small">
              {activeTab.hint}
              {tab === "missing" && ` Your following export lists ${analysis.deletedInExport} deleted account${analysis.deletedInExport === 1 ? "" : "s"} without a name.`}
            </p>
            {(tab === "deactivated" || tab === "whitelisted" || (tab === "unfollowedYou" && analysis.pendingUnfollowers.length > 0)) && (
              <div className="recheck">
                <p>
                  <strong>Recheck:</strong> {recheckTodo.length} of {recheckRows.length} due.
                  Opens the next {Math.min(recheckSettings.batchSize, recheckTodo.length)} profiles in new tabs. In each tab, if you see{" "}
                  <em>"Sorry, this page isn't available."</em> press <b>Unavailable</b> here. If the profile opens, press <b>Works</b>.
                </p>
                <div className="recheck-settings">
                  <label>
                    Tabs per round{" "}
                    <select value={recheckSettings.batchSize} onChange={e => changeRecheckSettings({ batchSize: Number(e.currentTarget.value) })}>
                      {RECHECK_BATCH_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
                    </select>
                  </label>
                  <label>
                    Recheck again after{" "}
                    <select
                      value={recheckSettings.maxAgeDays === null ? "never" : String(recheckSettings.maxAgeDays)}
                      onChange={e => changeRecheckSettings({ maxAgeDays: e.currentTarget.value === "never" ? null : Number(e.currentTarget.value) })}
                    >
                      <option value="never">never</option>
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="180">180 days</option>
                    </select>
                  </label>
                  <label>
                    Order{" "}
                    <select value={recheckSettings.order} onChange={e => changeRecheckSettings({ order: e.currentTarget.value as RecheckOrder })}>
                      <option value="newest">newest follow first</option>
                      <option value="oldest">oldest follow first</option>
                      <option value="az">A to Z</option>
                    </select>
                  </label>
                </div>
                <p className="small">
                  {tab === "unfollowedYou"
                    ? `These followers are in your last snapshot but gone now. If the profile opens normally, press "Page works" (they unfollowed you: it is recorded in the unfollowed column). If it says the page isn't available, press "Unavailable" (it is marked deactivated, not an unfollow). A block also shows that message, which cannot be told apart from a deactivation.`
                    : tab === "whitelisted"
                    ? `Whitelisting does not mean an account is still active. "Unavailable" marks it is_deactivated and it stays whitelisted; "Works" clears that mark. ${whitelistedAndDeactivated} whitelisted account${whitelistedAndDeactivated === 1 ? " is" : "s are"} marked deactivated right now.`
                    : `"Works" clears the deactivated mark and sends the account back to review; "Unavailable" keeps the mark.`}
                </p>
                <p className="small">
                  Instagram shows that message for deactivated, deleted, renamed <em>and</em> blocked accounts alike, so "unavailable" only
                  confirms the page is gone. Log in to Instagram first, and allow pop-ups for this page if your browser asks.
                </p>
                <div className="recheck-actions">
                  <button type="button" className="primary" disabled={recheckTodo.length === 0 || batch.length > 0} onClick={openRecheckBatch}>
                    Open next {Math.min(recheckSettings.batchSize, recheckTodo.length)} tabs
                  </button>
                  {batch.length > 0 && (
                    <button type="button" onClick={() => batch.slice().forEach(name => decide(name, "unavailable"))}>All unavailable (A)</button>
                  )}
                  {hasRechecks(data) && (
                    <button type="button" className="link" onClick={() => { change(d => clearRechecks(d)); setBatch([]); }}>Reset rechecks</button>
                  )}
                </div>
                {batch.length > 0 && (
                  <>
                    <p className="small keys">
                      Keys: <kbd>U</kbd> = unavailable, <kbd>W</kbd> = works (for the highlighted account, the first tab you opened),{" "}
                      <kbd>A</kbd> = all unavailable. Going through the tabs in order, you can just type e.g. <kbd>u</kbd> <kbd>u</kbd> <kbd>w</kbd> <kbd>u</kbd> <kbd>u</kbd>.
                    </p>
                    <ul className="batch">
                      {batch.map((name, index) => (
                        <li key={name} className={index === 0 ? "next" : ""}>
                          <strong>@{name}</strong>
                          <a className="button view" href={profileLink(name)} target="_blank" rel="noopener noreferrer">Open ↗</a>
                          <button type="button" onClick={() => decide(name, "unavailable")}>Unavailable</button>
                          <button type="button" className="primary" onClick={() => decide(name, "works")}>{tab === "unfollowedYou" ? "Page works" : "Works"}</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            <input
              className="search"
              type="search"
              placeholder="Search username…"
              value={query}
              onInput={e => { setQuery(e.currentTarget.value); setPage(1); }}
              aria-label="Search username"
            />
            {rows.length === 0 ? (
              <p className="empty">{needle !== "" ? "No match." : "Nothing here."}</p>
            ) : (
              <ul className="rows">
                {visible.map(row => (
                  <RowView key={row.username} row={row} tab={tab} onChange={change} />
                ))}
              </ul>
            )}
            {pageCount > 1 && (
              <div className="pager">
                <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹ Previous</button>
                <span>Page {safePage} of {pageCount}</span>
                <button type="button" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>Next ›</button>
              </div>
            )}
          </section>
        </>
      )}

      {!haveLists && (
        <section className="how">
          <h2>How it works</h2>
          <ol>
            <li>Load your following and followers files from the Instagram export (HTML or JSON), and your workbook if you have one.</li>
            <li>The page lists everyone you follow who does not follow you back, ignoring your whitelist, renamed and already-unfollowed accounts.</li>
            <li>Open each profile, unfollow in Instagram yourself, then press <b>Unfollowed ✓</b>.</li>
            <li>Press <b>Save workbook</b> to keep your whitelist and unfollowed log in an .xlsx file you can open in Excel or Google Sheets.</li>
          </ol>
        </section>
      )}

      <footer className="foot small">
        <img className="avatar small" src={PROFILE_IMAGE} alt="" width={28} height={28} />
        <span>
          {APP_NAME} by {AUTHOR_NAME}. Everything on this page stays on your device. Looking for the old online scanner that needs your
          Instagram login? <a href="scanner.html">scanner.html</a>
        </span>
      </footer>
    </div>
  );
};

render(<App />, document.getElementById("root") as HTMLElement);
