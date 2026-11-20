import React from 'react';
import { Language, t } from '../utils/i18n';
import { UserNode } from '../model/user';
import { GhostArt } from './icons/Logo';

interface NotSearchingProps {
  onScan?: () => void;
  lang: Language;
  cachedScan?: { readonly results: readonly UserNode[]; readonly timestamp: number } | null;
  onLoadCached?: () => void;
  // An interrupted scan saved in this browser (progress in percent) that can be picked up again.
  savedScanPercentage?: number | null;
  onResumeSaved?: () => void;
}

export const NotSearching = ({onScan, lang, cachedScan, onLoadCached, savedScanPercentage, onResumeSaved}: NotSearchingProps) => (
  <section className="launch-screen">
    <div className="launch-copy">
      <span className="eyebrow">{t(lang, "localAccountAudit")}</span>
      <h1>{t(lang, "launchTitle")}</h1>
      <p>
        {t(lang, "launchDescription")}
      </p>
      <div className="launch-actions">
        <button className="run-scan" onClick={onScan}>
          {t(lang, "runScan")}
        </button>
        {savedScanPercentage !== null && savedScanPercentage !== undefined && onResumeSaved && (
          <button type="button" className="load-cached-scan" onClick={onResumeSaved}>
            ⏩ {t(lang, "resumeSavedScan", savedScanPercentage)}
          </button>
        )}
        {cachedScan && cachedScan.results.length > 0 && onLoadCached && (
          <button type="button" className="load-cached-scan" onClick={onLoadCached}>
            ⚡ {t(lang, "loadCachedScan", cachedScan.results.length)}
          </button>
        )}
        <span className="launch-note">{t(lang, "runsInBrowserOnly")}</span>
      </div>
    </div>
    <div className="launch-panel">
      <GhostArt className="ghost-art" />
      <ol className="steps">
        <li>
          <span className="step-no">1</span>
          <div>
            <strong>{t(lang, "stepScanTitle")}</strong>
            <span>{t(lang, "stepScanDesc")}</span>
          </div>
        </li>
        <li>
          <span className="step-no">2</span>
          <div>
            <strong>{t(lang, "stepReviewTitle")}</strong>
            <span>{t(lang, "stepReviewDesc", cachedScan ? cachedScan.results.length : 0)}</span>
          </div>
        </li>
        <li>
          <span className="step-no">3</span>
          <div>
            <strong>{t(lang, "stepUnfollowTitle")}</strong>
            <span>{t(lang, "stepUnfollowDesc")}</span>
          </div>
        </li>
      </ol>
    </div>
  </section>
);
