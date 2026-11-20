import React, { ChangeEvent, useEffect, useState } from "react";
import { render } from "react-dom";
import "./styles.scss";

import { Typename, UserNode } from "./model/user";
import { Toast } from "./components/Toast";
import { UserCheckIcon } from "./components/icons/UserCheckIcon";
import { UserUncheckIcon } from "./components/icons/UserUncheckIcon";
import {
  DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
  DEFAULT_TIME_BETWEEN_UNFOLLOWS,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
  DEFAULT_USERS_PER_SEARCH_CYCLE,
  BLOCKED_COOLDOWN_MS,
  FOLLOWERS_PAGE_SAFETY_LIMIT,
  FOLLOWING_PAGE_SAFETY_LIMIT,
  CHECKS_BEFORE_LONG_SLEEP,
  INSTAGRAM_HOSTNAME,
  MAX_SCAN_RETRIES,
  PAUSE_POLL_MS,
  SCAN_CHECKPOINT_SAVE_EVERY_PAGES,
} from "./constants/constants";
import {
  addFollowerToIndex,
  assertUnreachable,
  deduplicateUsersById,
  fetchFriendshipsPage,
  FriendshipsListKind,
  FriendshipsPage,
  getCookie,
  getCurrentPageUnfollowers,
  getUsersForDisplay,
  getViewerId,
  hasUnthrottledTimers,
  InstagramApiError,
  isUserNodeInFollowerIndex,
  RawFriendshipUser,
  rawFriendshipUserToUserNode,
  sleep,
  unfollowUser,
} from "./utils/utils";
import { NotSearching } from "./components/NotSearching";
import { State } from "./model/state";
import { Searching } from "./components/Searching";
import { Toolbar } from "./components/Toolbar";
import { Unfollowing } from "./components/Unfollowing";
import { Timings } from "./model/timings";
import { getBlockedUntil, loadCachedScanResults, loadTimings, loadWhitelist, saveCachedScanResults, saveTimings, saveWhitelist, setBlockedUntil } from "./utils/whitelist-manager";
import { getInitialLanguage, Language, saveLanguage, t } from "./utils/i18n";
import {
  adjustPaceMultiplier,
  classifyError,
  computeBackoffSeconds,
  walkList,
} from "./utils/scan-resilience";
import {
  checkpointPercentage,
  followersPhasePercentage,
  followingPhasePercentage,
  clearScanCheckpoint,
  createScanCheckpoint,
  loadScanCheckpoint,
  saveScanCheckpoint,
  ScanCheckpoint,
} from "./utils/scan-persistence";
import { localAvatar } from "./utils/avatar";
import { clampTimings, isValidInstagramId, lowerUsername } from "./utils/validation";

const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const isLocalPreview = LOCAL_PREVIEW_HOSTS.has(location.hostname);

const _avatarUrl = (seed: string): string => localAvatar(seed);

const _createPreviewUser = (
  id: string,
  username: string,
  fullName: string,
  options: { readonly isPrivate?: boolean; readonly isVerified?: boolean; readonly followsViewer?: boolean } = {},
): UserNode => ({
  id,
  username,
  full_name: fullName,
  profile_pic_url: _avatarUrl(username),
  is_private: options.isPrivate ?? false,
  is_verified: options.isVerified ?? false,
  followed_by_viewer: true,
  follows_viewer: options.followsViewer ?? false,
  requested_by_viewer: false,
  reel: {
    id,
    expiring_at: 0,
    has_pride_media: false,
    latest_reel_media: 0,
    seen: null,
    owner: {
      __typename: Typename.GraphUser,
      id,
      profile_pic_url: _avatarUrl(username),
      username,
    },
  },
});

const _getPreviewUsers = (): readonly UserNode[] => [
  _createPreviewUser("1", "alina.frames", "Alina Moreno", { isVerified: true }),
  _createPreviewUser("2", "brassandbone", "Theo Walsh", { isPrivate: true }),
  _createPreviewUser("3", "citrus.archive", "Mara Kim", { followsViewer: true }),
  _createPreviewUser("4", "dawnledger", "Jon Bell", { isPrivate: true }),
  _createPreviewUser("5", "elias.market", "Elias Noor", { isVerified: true }),
  _createPreviewUser("6", "fieldnotes.studio", "Nadia Reyes"),
  _createPreviewUser("7", "glint.supply", "Remy Park", { followsViewer: true }),
  _createPreviewUser("8", "harbor.sequence", "Ivy Chen", { isPrivate: true }),
  _createPreviewUser("9", "inkline.daily", "Sofia Grant"),
  _createPreviewUser("10", "juniper.signal", "Cal Reed", { isVerified: true }),
  _createPreviewUser("11", "keystone.labs", "Mina Torres"),
  _createPreviewUser("12", "lowlight.club", "Owen Voss", { isPrivate: true }),
];



function App() {
  const [state, setState] = useState<State>({
    ...(
      isLocalPreview && new URLSearchParams(location.search).get("preview") === "scanning"
        ? {
          status: "scanning",
          page: 1,
          searchTerm: "",
          currentTab: "non_whitelisted",
          percentage: 100,
          results: _getPreviewUsers(),
          selectedResults: _getPreviewUsers().slice(0, 3),
          whitelistedResults: _getPreviewUsers().slice(10, 12),
          filter: {
            showVerified: true,
            showPrivate: true,
            showWithOutProfilePicture: true,
          },
        } as State
        : { status: "initial" as const }
    ),
  });

  const [toast, setToast] = useState<{ readonly show: false } | { readonly show: true; readonly text: string }>({
    show: false,
  });

  const [timings, setTimingsUnchecked] = useState<Timings>(() => {
    const storedTimings = loadTimings();
    return {
      timeBetweenSearchCycles: storedTimings?.timeBetweenSearchCycles ?? DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
      timeToWaitAfterFiveSearchCycles: storedTimings?.timeToWaitAfterFiveSearchCycles ?? DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
      timeBetweenUnfollows: storedTimings?.timeBetweenUnfollows ?? DEFAULT_TIME_BETWEEN_UNFOLLOWS,
      timeToWaitAfterFiveUnfollows: storedTimings?.timeToWaitAfterFiveUnfollows ?? DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
      usersPerSearchCycle: storedTimings?.usersPerSearchCycle ?? DEFAULT_USERS_PER_SEARCH_CYCLE,
    };
  });

  // Whatever the settings form (or storage) hands over is forced back into the safe range.
  const setTimings = (newTimings: Timings) => setTimingsUnchecked(clampTimings(newTimings));

  // Save timings whenever they change
  useEffect(() => {
    saveTimings(timings);
  }, [timings]);

  const [cachedScan, setCachedScan] = useState<{ readonly results: readonly UserNode[]; readonly timestamp: number } | null>(() =>
    loadCachedScanResults(),
  );

  // Progress (percent) of an interrupted scan saved by a previous page load, if any.
  const readSavedScanPercentage = (): number | null => {
    const id = getViewerId();
    const saved = id === null ? null : loadScanCheckpoint(id);
    return saved === null ? null : checkpointPercentage(saved.checkpoint);
  };
  const [savedScanPercentage, setSavedScanPercentage] = useState<number | null>(() => readSavedScanPercentage());

  const [lang, setLang] = useState<Language>(() => getInitialLanguage());

  const [scanningPaused, setScanningPaused] = useState(false);
  const scanningPausedRef = React.useRef(false);

  // Resume support: the checkpoint survives a failed scan, the counter re-triggers the scan effect.
  const checkpointRef = React.useRef<ScanCheckpoint | null>(null);
  const scanRunningRef = React.useRef(false);
  const paceMultiplierRef = React.useRef(1);
  const [scanRun, setScanRun] = useState(0);

  const pauseScan = () => {
    setScanningPaused(prev => {
      const next = !prev;
      scanningPausedRef.current = next;
      return next;
    });
  };

  const handleLanguageChange = (newLang: Language) => {
    setLang(newLang);
    saveLanguage(newLang);
  };


  let isActiveProcess: boolean;
  switch (state.status) {
    case "initial":
      isActiveProcess = false;
      break;
    case "scanning":
      isActiveProcess = Boolean(state.isScanningActive);
      break;
    case "unfollowing":
      isActiveProcess = !state.aborted && state.percentage < 100;
      break;
    default:
      assertUnreachable(state);
  }

  const onLoadCached = () => {
    // Re-read instead of trusting the mount-time snapshot: the account may have
    // been switched in another tab, and the cache is scoped per account.
    const cached = loadCachedScanResults();
    setCachedScan(cached);
    if (!cached || cached.results.length === 0) {
      return;
    }
    const whitelistedResults = loadWhitelist();
    setState({
      status: "scanning",
      page: 1,
      searchTerm: "",
      currentTab: "non_whitelisted",
      percentage: 100,
      isScanningActive: false,
      results: cached.results,
      selectedResults: [],
      whitelistedResults,
      filter: {
        showVerified: true,
        showPrivate: true,
        showWithOutProfilePicture: true,
      },
    });
    setToast({
      show: true,
      text: t(lang, "loadedFromCache", cached.results.length),
    });
  };

  const onScan = async () => {
    if (state.status !== "initial") {
      return;
    }
    if (isLocalPreview) {
      const previewUsers = _getPreviewUsers();
      setState({
        status: "scanning",
        page: 1,
        searchTerm: "",
        currentTab: "non_whitelisted",
        percentage: 100,
        isScanningActive: false,
        results: previewUsers,
        selectedResults: previewUsers.slice(0, 3),
        whitelistedResults: previewUsers.slice(10, 12),
        filter: {
          showVerified: true,
          showPrivate: true,
          showWithOutProfilePicture: true,
        },
      });
      return;
    }
    const blockedUntil = getBlockedUntil();
    if (blockedUntil > Date.now()) {
      setToast({
        show: true,
        text: t(lang, "rateLimitPause", Math.ceil((blockedUntil - Date.now()) / 1000)),
      });
      return;
    }
    checkpointRef.current = null;
    // A brand-new scan replaces any saved interrupted one.
    clearScanCheckpoint(getViewerId());
    setSavedScanPercentage(null);
    paceMultiplierRef.current = 1;
    const whitelistedResults = loadWhitelist();
    setState({
      status: "scanning",
      page: 1,
      searchTerm: "",
      currentTab: "non_whitelisted",
      percentage: 0,
      isScanningActive: true,
      results: [],
      selectedResults: [],
      whitelistedResults,
      filter: {
        showVerified: true,
        showPrivate: true,
        showWithOutProfilePicture: true,
      },
    });
  };

  // Picks up a scan that a reload / discarded tab interrupted, from the saved checkpoint.
  const onResumeSavedScan = () => {
    if (state.status !== "initial" || scanRunningRef.current) {
      return;
    }
    const viewerId = getViewerId();
    const saved = viewerId === null ? null : loadScanCheckpoint(viewerId);
    if (saved === null) {
      setSavedScanPercentage(null);
      setToast({ show: true, text: t(lang, "resumeNothingToResume") });
      return;
    }
    const blockedUntil = getBlockedUntil();
    if (blockedUntil > Date.now()) {
      setToast({
        show: true,
        text: t(lang, "resumeBlockedWait", Math.ceil((blockedUntil - Date.now()) / 1000)),
      });
      return;
    }
    const { checkpoint } = saved;
    // Must be in place before the status change that starts the scan effect.
    checkpointRef.current = checkpoint;
    paceMultiplierRef.current = 1;
    scanningPausedRef.current = false;
    setScanningPaused(false);
    setSavedScanPercentage(null);
    setState({
      status: "scanning",
      page: 1,
      searchTerm: "",
      currentTab: "non_whitelisted",
      percentage: checkpointPercentage(checkpoint),
      isScanningActive: true,
      results: [...checkpoint.candidates],
      selectedResults: [],
      whitelistedResults: loadWhitelist(),
      totalScanned: checkpoint.followingCount,
      filter: {
        showVerified: true,
        showPrivate: true,
        showWithOutProfilePicture: true,
      },
    });
    setToast({ show: true, text: t(lang, "savedScanResumed") });
  };

  const onResumeScan = () => {
    if (state.status !== "scanning" || !state.scanIncomplete || state.isScanningActive || scanRunningRef.current) {
      return;
    }
    const checkpoint = checkpointRef.current;
    if (checkpoint === null) {
      setToast({ show: true, text: t(lang, "resumeNothingToResume") });
      return;
    }
    if (getViewerId() !== checkpoint.viewerId) {
      // Another account is logged in now: the checkpoint belongs to the old one.
      checkpointRef.current = null;
      setState({ status: "initial" });
      setToast({ show: true, text: t(lang, "scanAccountChanged") });
      return;
    }
    const blockedUntil = getBlockedUntil();
    if (blockedUntil > Date.now()) {
      setToast({
        show: true,
        text: t(lang, "resumeBlockedWait", Math.ceil((blockedUntil - Date.now()) / 1000)),
      });
      return;
    }
    scanningPausedRef.current = false;
    setScanningPaused(false);
    setState({
      ...state,
      scanIncomplete: false,
      isScanningActive: true,
      percentage: Math.min(99, state.percentage),
    });
    setScanRun(run => run + 1);
    setToast({ show: true, text: t(lang, "scanResumed") });
  };

  const handleScanFilter = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "scanning") {
      return;
    }
    if (state.selectedResults.length > 0) {
      if (!confirm("Changing filter options will clear selected users")) {
        // Force re-render. Bit of a hack but had an issue where the checkbox state was still
        // changing in the UI even even when not confirming. So updating the state fixes this
        // by synchronizing the checkboxes with the filter statuses in the state.
        setState({ ...state });
        return;
      }
    }
    setState({
      ...state,
      // Make sure to clear selected results when changing filter options. This is to avoid having
      // users selected in the unfollow queue but not visible in the UI, which would be confusing.
      selectedResults: [],
      filter: {
        ...state.filter,
        [e.currentTarget.name]: e.currentTarget.checked,
      },
    });
  };

  const handleUnfollowFilter = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "unfollowing") {
      return;
    }
    setState({
      ...state,
      filter: {
        ...state.filter,
        [e.currentTarget.name]: e.currentTarget.checked,
      },
    });
  };

  const toggleUser = (newStatus: boolean, user: UserNode) => {
    if (state.status !== "scanning") {
      return;
    }
    if (newStatus) {
      setState({
        ...state,
        selectedResults: [...state.selectedResults, user],
      });
    } else {
      setState({
        ...state,
        selectedResults: state.selectedResults.filter(result => result.id !== user.id),
      });
    }
  };

  const toggleAllUsers = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "scanning") {
      return;
    }
    const displayed = getUsersForDisplay(
      state.results,
      state.whitelistedResults,
      state.currentTab,
      state.searchTerm,
      state.filter,
    );
    if (e.currentTarget.checked) {
      const currentIds = new Set(state.selectedResults.map(u => u.id));
      const toAdd = displayed.filter(u => !currentIds.has(u.id));
      setState({
        ...state,
        selectedResults: [...state.selectedResults, ...toAdd],
      });
    } else {
      const displayedIds = new Set(displayed.map(u => u.id));
      setState({
        ...state,
        selectedResults: state.selectedResults.filter(u => !displayedIds.has(u.id)),
      });
    }
  };

  // it will work the same as toggleAllUsers, but it will select everyone on the current page.
  const toggleCurrentePageUsers = (e: ChangeEvent<HTMLInputElement>) => {
    if (state.status !== "scanning") {
      return;
    }
    const pageUsers = getCurrentPageUnfollowers(
      getUsersForDisplay(
        state.results,
        state.whitelistedResults,
        state.currentTab,
        state.searchTerm,
        state.filter,
      ),
      state.page,
    );
    if (e.currentTarget.checked) {
      const currentIds = new Set(state.selectedResults.map(u => u.id));
      const toAdd = pageUsers.filter(u => !currentIds.has(u.id));
      setState({
        ...state,
        selectedResults: [...state.selectedResults, ...toAdd],
      });
    } else {
      const pageUserIds = new Set(pageUsers.map(u => u.id));
      setState({
        ...state,
        selectedResults: state.selectedResults.filter(u => !pageUserIds.has(u.id)),
      });
    }
  };

  const onWhitelistUpdate = (updatedWhitelist: readonly UserNode[]) => {
    saveWhitelist(updatedWhitelist);
    if (state.status === "scanning") {
      setState({
        ...state,
        whitelistedResults: updatedWhitelist,
      });
    }
  };

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Prompt user if he tries to leave while in the middle of a process (searching / unfollowing / etc..)
      // This is especially good for avoiding accidental tab closing which would result in a frustrating experience.
      if (!isActiveProcess) {
        return;
      }

      // `e` Might be undefined in older browsers, so silence linter for this one.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      e = e || window.event;

      // `e` Might be undefined in older browsers, so silence linter for this one.
      // For IE and Firefox prior to version 4
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (e) {
        e.returnValue = "Changes you made may not be saved.";
      }

      // For Safari
      return "Changes you made may not be saved.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isActiveProcess, state]);

  // Save the scan whenever the tab is hidden or going away, on top of the
  // periodic save: that is when a browser is most likely to discard the tab.
  useEffect(() => {
    const saveNow = () => {
      if (scanRunningRef.current && checkpointRef.current !== null) {
        saveScanCheckpoint(checkpointRef.current);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        saveNow();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", saveNow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", saveNow);
    };
  }, []);

  useEffect(() => {
    if (state.status !== "scanning" || isLocalPreview || state.percentage === 100 || !state.isScanningActive) {
      return;
    }
    // One scan at a time: a stray re-render must never start a second walk.
    if (scanRunningRef.current) {
      return;
    }

    const viewerId = getViewerId();
    if (viewerId === null) {
      setState(prevState =>
        prevState.status === "scanning" ? { ...prevState, isScanningActive: false } : prevState,
      );
      setToast({ show: true, text: t(lang, "scanFailedFollowing") });
      return;
    }
    scanRunningRef.current = true;

    const scanAccountChanged = new Error("Instagram account changed during scan");
    const checkScanAccount = () => {
      if (getViewerId() !== viewerId) {
        throw scanAccountChanged;
      }
    };

    // Fetches one page, retrying with exponential backoff (and Instagram's own
    // Retry-After when it sends one) on rate limits, soft blocks, 5xx and
    // network errors. `blocked` is true when retries were exhausted for such a
    // transient error: the scan stops *but keeps its place*, so "Resume scan"
    // can carry on from this exact page. false means a non-retryable error
    // (e.g. 404 / unavailable account).
    type PageResult =
      | { readonly ok: true; readonly page: FriendshipsPage }
      | { readonly ok: false; readonly blocked: boolean };

    const fetchPageWithRetry = async (
      kind: FriendshipsListKind,
      maxId?: string,
      count?: number,
    ): Promise<PageResult> => {
      let attempt = 0;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        checkScanAccount();
        try {
          const page = await fetchFriendshipsPage(kind, maxId, count, viewerId);
          paceMultiplierRef.current = adjustPaceMultiplier(paceMultiplierRef.current, "clean-page");
          return { ok: true, page };
        } catch (e: unknown) {
          checkScanAccount();
          const errorKind = classifyError(e);
          const isTransient = errorKind !== "fatal";

          if (isTransient && attempt < MAX_SCAN_RETRIES) {
            attempt++;
            if (errorKind === "rate-limit") {
              // Instagram is throttling us: slow every following request down too.
              paceMultiplierRef.current = adjustPaceMultiplier(paceMultiplierRef.current, "throttled");
            }
            const waitSeconds = computeBackoffSeconds(
              attempt,
              errorKind,
              e instanceof InstagramApiError ? e.retryAfterSeconds : undefined,
            );
            for (let sec = waitSeconds; sec > 0; sec--) {
              checkScanAccount();
              setToast({
                show: true,
                text: t(lang, "rateLimitPause", sec),
              });
              await sleep(1000);
            }
            setToast({ show: false });
            // The cooldown ran in real time; if the user paused meanwhile, hold here.
            await waitWhilePaused();
            continue;
          }
          console.error(`${kind} request failed after ${attempt} retries:`, e);
          if (errorKind === "rate-limit") {
            // Remember the throttle so the next scan/unfollow does not walk straight back into it.
            setBlockedUntil(Date.now() + BLOCKED_COOLDOWN_MS);
          }
          return { ok: false, blocked: isTransient };
        }
      }
    };

    // Blocks while the user has the scan paused. Polled in short slices so
    // Pause / Resume react almost instantly.
    const waitWhilePaused = async () => {
      while (scanningPausedRef.current) {
        checkScanAccount();
        await sleep(PAUSE_POLL_MS);
      }
    };

    // Like sleep(), but never waits out a long delay while paused: the wait is
    // cut into short slices, and the clock stops while the user has paused.
    //
    // The slicing only happens when timers run in a worker: on a throttled
    // main-thread timer every slice could cost up to a minute in a background
    // tab, so there the wait stays one piece (Pause then waits it out).
    const pausableSleep = async (ms: number) => {
      const sliceMs = hasUnthrottledTimers() ? PAUSE_POLL_MS : ms;
      let remaining = ms;
      while (remaining > 0) {
        await waitWhilePaused();
        const slice = Math.min(sliceMs, remaining);
        await sleep(slice);
        remaining -= slice;
      }
      await waitWhilePaused();
    };

    let requestsSinceLongSleep = 0;
    let pagesSinceSave = 0;
    const paceRequest = async () => {
      // pace runs right after the cursor advanced, so this is a consistent
      // point to save: the saved scan resumes at exactly the next page.
      pagesSinceSave++;
      if (pagesSinceSave >= SCAN_CHECKPOINT_SAVE_EVERY_PAGES && checkpointRef.current !== null) {
        pagesSinceSave = 0;
        saveScanCheckpoint(checkpointRef.current);
      }

      await waitWhilePaused();

      // Every delay is stretched by the adaptive multiplier (1x normally, up
      // to 4x right after Instagram throttled us).
      const multiplier = paceMultiplierRef.current;
      await pausableSleep(Math.floor((Math.floor(Math.random() * 700) + 300) * multiplier));
      await pausableSleep(Math.floor((Math.floor(Math.random() * (timings.timeBetweenSearchCycles - timings.timeBetweenSearchCycles * 0.7)) + timings.timeBetweenSearchCycles) * multiplier));

      requestsSinceLongSleep++;
      if (requestsSinceLongSleep >= CHECKS_BEFORE_LONG_SLEEP) {
        requestsSinceLongSleep = 0;
        const longSleepVar = Math.max(
          0,
          (timings.timeToWaitAfterFiveSearchCycles + (Math.random() * 10000 - 5000)) * multiplier, // +/- 5 seconds
        );
        setToast({
          show: true,
          text: t(lang, "sleepingSafety", Math.round(longSleepVar / 1000)),
        });
        await pausableSleep(longSleepVar);
      }
      setToast({ show: false });
    };

    const scan = async () => {
      // Reuse the checkpoint of an interrupted scan of this same account so
      // "Resume scan" continues instead of starting over.
      let existing = checkpointRef.current;
      if (existing === null || existing.viewerId !== viewerId) {
        existing = createScanCheckpoint(viewerId);
        checkpointRef.current = existing;
      }
      const checkpoint = existing;

      const stopAsIncomplete = (failureToast: "scanFailedFollowers" | "scanFailedFollowing") => {
        // Keep the exact stopping point on disk too, in case the page reloads before "Resume scan" is pressed.
        saveScanCheckpoint(checkpoint);
        setState(prevState =>
          prevState.status === "scanning"
            ? { ...prevState, isScanningActive: false, scanIncomplete: true }
            : prevState,
        );
        setToast({ show: true, text: t(lang, failureToast) });
      };

      // Pass 1: load every account you follow. They are listed in the UI as
      // they arrive, as *candidates*: nobody has been checked against your
      // followers yet, so the list is provisional (and unfollow stays locked).
      const loadFollowingPage = (pageUsers: readonly RawFriendshipUser[]): boolean => {
        const batch = deduplicateUsersById(
          pageUsers.map(user => rawFriendshipUserToUserNode(user, false)),
          checkpoint.seenFollowingIds,
        );
        checkpoint.followingCount += pageUsers.length;
        checkpoint.candidates.push(...batch);

        setState(prevState =>
          prevState.status === "scanning"
            ? {
                ...prevState,
                results: batch.length > 0 ? [...prevState.results, ...batch] : prevState.results,
                totalScanned: checkpoint.followingCount,
                percentage: followingPhasePercentage(checkpoint.followingCount),
              }
            : prevState,
        );
        setToast({
          show: true,
          text: t(lang, "loadingFollowingProgress", checkpoint.followingCount),
        });
        return true;
      };

      const followingWalk = await walkList<RawFriendshipUser>({
        cursor: checkpoint.followingCursor,
        pageSafetyLimit: FOLLOWING_PAGE_SAFETY_LIMIT,
        fetchPage: maxId => fetchPageWithRetry("following", maxId, timings.usersPerSearchCycle),
        onPage: loadFollowingPage,
        pace: paceRequest,
      });
      checkScanAccount();

      if (!followingWalk.completed) {
        console.error(`Following scan stopped early (${followingWalk.reason}).`);
        stopAsIncomplete("scanFailedFollowing");
        return;
      }

      setState(prevState =>
        prevState.status === "scanning"
          ? { ...prevState, percentage: Math.max(prevState.percentage, 50) }
          : prevState,
      );

      // Pass 2: walk your followers. Everyone who follows you back is removed
      // from the candidates as their page arrives, so the list shrinks to the
      // real non-followers. Matching by id AND lowercase username keeps false
      // positives at zero.
      const checkFollowersPage = (pageUsers: readonly RawFriendshipUser[]): boolean => {
        for (const user of pageUsers) {
          addFollowerToIndex(checkpoint.followerIndex, user);
        }
        checkpoint.followersCount += pageUsers.length;
        checkpoint.candidates = checkpoint.candidates.filter(
          candidate => !isUserNodeInFollowerIndex(checkpoint.followerIndex, candidate),
        );

        const remaining = [...checkpoint.candidates];
        setState(prevState =>
          prevState.status === "scanning"
            ? {
                ...prevState,
                results: remaining,
                totalScanned: checkpoint.followersCount,
                percentage: followersPhasePercentage(checkpoint.followersCount),
              }
            : prevState,
        );
        setToast({
          show: true,
          text: t(lang, "checkingFollowersProgress", checkpoint.followersCount),
        });
        return true;
      };

      const followersWalk = await walkList<RawFriendshipUser>({
        cursor: checkpoint.followersCursor,
        pageSafetyLimit: FOLLOWERS_PAGE_SAFETY_LIMIT,
        fetchPage: maxId => fetchPageWithRetry("followers", maxId, timings.usersPerSearchCycle),
        onPage: checkFollowersPage,
        pace: paceRequest,
      });
      checkScanAccount();

      if (!followersWalk.completed) {
        // The candidate list is still provisional (it can include people who do
        // follow you), which is why unfollow stays locked. The checkpoint is
        // kept so the scan resumes from the page that failed.
        console.error(`Followers scan stopped early (${followersWalk.reason}).`);
        stopAsIncomplete("scanFailedFollowers");
        return;
      }

      // Only a scan that walked both lists to the end is cached: a partial
      // result must never come back later looking like a finished audit.
      saveCachedScanResults(checkpoint.candidates, viewerId);
      clearScanCheckpoint(viewerId);
      setCachedScan({ results: [...checkpoint.candidates], timestamp: Date.now() });

      setState(prevState => {
        if (prevState.status !== "scanning") {
          return prevState;
        }
        return {
          ...prevState,
          percentage: 100,
          scanIncomplete: false,
          isScanningActive: false,
          results: [...checkpoint.candidates],
          totalScanned: checkpoint.followingCount,
        };
      });
      checkpointRef.current = null;

      setToast({
        show: true,
        text: t(lang, "scanCompleted"),
      });
    };

    scan()
      .catch(error => {
        if (error === scanAccountChanged) {
          // The saved progress belongs to the account the scan started under.
          clearScanCheckpoint(viewerId);
          checkpointRef.current = null;
          scanningPausedRef.current = false;
          setScanningPaused(false);
          setCachedScan(loadCachedScanResults());
          setState({ status: "initial" });
          setToast({ show: true, text: t(lang, "scanAccountChanged") });
          return;
        }
        // Any other unexpected failure: never leave the UI stuck on "scanning".
        // Stop as incomplete (unfollow stays locked) and keep the checkpoint so
        // the scan can be resumed.
        console.error("Scan crashed:", error);
        setState(prevState =>
          prevState.status === "scanning"
            ? { ...prevState, isScanningActive: false, scanIncomplete: true }
            : prevState,
        );
        setToast({ show: true, text: t(lang, "scanFailedFollowing") });
      })
      .then(() => {
        scanRunningRef.current = false;
      });
    // Dependency array not entirely legit, but works this way. TODO: Find a way to fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, scanRun]);

  useEffect(() => {
    const unfollow = async () => {
      if (state.status !== "unfollowing" || isLocalPreview) {
        return;
      }

      const blockedUntil = getBlockedUntil();
      if (blockedUntil > Date.now()) {
        setToast({
          show: true,
          text: t(lang, "rateLimitPause", Math.ceil((blockedUntil - Date.now()) / 1000)),
        });
        setState(prevState => (prevState.status === "unfollowing" ? { ...prevState, aborted: true } : prevState));
        return;
      }

      const csrftoken = getCookie("csrftoken");
      const unfollowViewerId = getViewerId();
      if (csrftoken === null || unfollowViewerId === null) {
        console.error("Not logged in to Instagram: csrftoken / ds_user_id cookie missing");
        setToast({ show: true, text: t(lang, "scanFailedFollowing") });
        setState(prevState => (prevState.status === "unfollowing" ? { ...prevState, aborted: true } : prevState));
        return;
      }

      // Final safety net, independent of what the UI let through: whitelisted
      // accounts and anything without a plain numeric id are never sent to Instagram.
      const protectedWhitelist = loadWhitelist();
      const protectedIds = new Set(protectedWhitelist.map(u => u.id));
      const protectedNames = new Set(protectedWhitelist.map(lowerUsername));
      let skippedCount = 0;
      let consecutiveFailures = 0;

      let counter = 0;
      for (const user of state.selectedResults) {
        counter += 1;
        // Fix: Changed from Math.floor to Math.round to ensure progress reaches 100%
        // Math.floor would leave progress at 99% when near completion
        const percentage = Math.round((counter / state.selectedResults.length) * 100);

        if (protectedIds.has(user.id) || protectedNames.has(lowerUsername(user)) || !isValidInstagramId(user.id)) {
          skippedCount += 1;
          setState(prevState =>
            prevState.status === "unfollowing"
              ? { ...prevState, percentage, unfollowLog: [...prevState.unfollowLog, { user, unfollowedSuccessfully: false }] }
              : prevState,
          );
          setToast({ show: true, text: t(lang, "unfollowWhitelistSkipped", skippedCount) });
          continue;
        }

        // Never keep unfollowing if another account got logged in meanwhile.
        if (getViewerId() !== unfollowViewerId) {
          setToast({ show: true, text: t(lang, "scanAccountChanged") });
          setState(prevState => (prevState.status === "unfollowing" ? { ...prevState, aborted: true } : prevState));
          break;
        }
        try {
          const result = await unfollowUser(user, csrftoken);
          const success = result.outcome === "unfollowed";
          const isActionBlocked = result.outcome === "blocked";
          if (!success) {
            console.warn(`Unfollow for ${user.username} not confirmed: ${result.detail}`);
            consecutiveFailures += 1;
          } else {
            consecutiveFailures = 0;
          }
          setState(prevState => {
            if (prevState.status !== "unfollowing") {
              return prevState;
            }
            return {
              ...prevState,
              percentage,
              unfollowLog: [
                ...prevState.unfollowLog,
                {
                  user,
                  unfollowedSuccessfully: success,
                },
              ],
            };
          });

          if (isActionBlocked) {
            setBlockedUntil(Date.now() + BLOCKED_COOLDOWN_MS);
            setToast({
              show: true,
              text: t(lang, "actionBlockedWarning"),
            });
            setState(prevState => (prevState.status === "unfollowing" ? { ...prevState, aborted: true } : prevState));
            break;
          }
          // Three failures in a row means the endpoint changed or the session is broken:
          // stop instead of sending dozens more doomed requests.
          if (consecutiveFailures >= 3) {
            setToast({ show: true, text: t(lang, "unfollowTooManyFailures") });
            setState(prevState => (prevState.status === "unfollowing" ? { ...prevState, aborted: true } : prevState));
            break;
          }
        } catch (e) {
          console.error(e);
          consecutiveFailures += 1;
          setState(prevState => {
            if (prevState.status !== "unfollowing") {
              return prevState;
            }
            return {
              ...prevState,
              percentage,
              unfollowLog: [
                ...prevState.unfollowLog,
                {
                  user,
                  unfollowedSuccessfully: false,
                },
              ],
            };
          });
        }
        // If unfollowing the last user in the list, no reason to wait.
        if (user === state.selectedResults[state.selectedResults.length - 1]) {
          break;
        }
        await sleep(Math.floor(Math.random() * (timings.timeBetweenUnfollows * 1.2 - timings.timeBetweenUnfollows)) + timings.timeBetweenUnfollows);

        if (counter % 5 === 0) {
          setToast({
            show: true,
            text: t(lang, "sleepingSafety", `${Math.round(timings.timeToWaitAfterFiveUnfollows / 60000)}m`),
          });
          await sleep(timings.timeToWaitAfterFiveUnfollows);
        }
        setToast({ show: false });
      }
    };
    unfollow();
    // Dependency array not entirely legit, but works this way. TODO: Find a way to fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  let markup: React.JSX.Element;
  switch (state.status) {
    case "initial":
      markup = <NotSearching onScan={onScan} lang={lang} cachedScan={cachedScan} onLoadCached={onLoadCached} savedScanPercentage={savedScanPercentage} onResumeSaved={onResumeSavedScan}></NotSearching>;
      break;

    case "scanning": {
      markup = <Searching
        state={state}
        handleScanFilter={handleScanFilter}
        toggleUser={toggleUser}
        pauseScan={pauseScan}
        onResumeScan={onResumeScan}
        setState={setState}
        scanningPaused={scanningPaused}
        UserCheckIcon={UserCheckIcon}
        UserUncheckIcon={UserUncheckIcon}
        lang={lang}
      ></Searching>;
      break;
    }

    case "unfollowing":
      markup = <Unfollowing
        state={state}
        handleUnfollowFilter={handleUnfollowFilter}
        lang={lang}
      ></Unfollowing>;
      break;

    default:
      assertUnreachable(state);
  }

  const showScanWarning = state.status === "scanning" && state.results.length === 0;

  return (
    <main id="main" role="main" className={`iu ${showScanWarning ? "has-scan-warning" : ""}`}>
      <section className="overlay">
        <Toolbar
          state={state}
          setState={setState}
          isActiveProcess={isActiveProcess}
          toggleAllUsers={toggleAllUsers}
          toggleCurrentePageUsers={toggleCurrentePageUsers}
          setTimings={setTimings}
          currentTimings={timings}
          whitelistedUsers={state.status === "scanning" ? state.whitelistedResults : loadWhitelist()}
          onWhitelistUpdate={onWhitelistUpdate}
          lang={lang}
          onLanguageChange={handleLanguageChange}
        ></Toolbar>

        {markup}

        {toast.show && <Toast show={toast.show} message={toast.text} onClose={() => setToast({ show: false })} />}
      </section>
    </main>
  );
}

if (location.hostname !== INSTAGRAM_HOSTNAME && !isLocalPreview) {
  alert("Can be used only on Instagram routes");
} else {
  document.title = "Artisya Yan?!";
  document.body.innerHTML = "";
  render(<App />, document.body);
}
