import React, { FC } from "react";

/** The mascot: a friendly ghost with a violet tail flick. */
export const Logo: FC = () => (
  <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M32 6c-10.5 0-18 7.6-18 18v26c0 2 2.3 3 3.8 1.6l4-3.7a2.5 2.5 0 0 1 3.4 0l3.4 3.2a2.5 2.5 0 0 0 3.4 0l3.4-3.2a2.5 2.5 0 0 1 3.4 0l4 3.7C47.7 53 50 52 50 50V24C50 13.6 42.500 6 32 6Z"
      fill="var(--surface)"
      stroke="var(--ink)"
      strokeWidth="3"
      strokeLinejoin="round"
    />
    <circle cx="25" cy="26" r="3.2" fill="var(--ink)" />
    <circle cx="39" cy="26" r="3.2" fill="var(--ink)" />
    <path d="M27 34c1.600 2.200 8.400 2.200 10 0" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
    <path d="M52 14l4-4M54 22h5" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

/** Larger illustration for the launch screen. */
export const GhostArt: FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="100" cy="184" rx="48" ry="7" fill="var(--ink)" opacity="0.18" />
    <path
      d="M100 16c-34 0-58 24-58 58v84c0 6.500 7.500 9.800 12.300 5.300l13-12a8 8 0 0 1 11 0l11 10.500a8 8 0 0 0 11 0l11-10.500a8 8 0 0 1 11 0l13 12c4.800 4.500 12.300 1.200 12.300-5.300V74c0-34-24-58-58-58Z"
      fill="var(--surface)"
      stroke="var(--ink)"
      strokeWidth="6"
      strokeLinejoin="round"
    />
    <ellipse cx="78" cy="78" rx="9" ry="12" fill="var(--ink)" />
    <ellipse cx="122" cy="78" rx="9" ry="12" fill="var(--ink)" />
    <circle cx="81" cy="73" r="3" fill="var(--surface)" />
    <circle cx="125" cy="73" r="3" fill="var(--surface)" />
    <path d="M86 108c5 6.500 23 6.500 28 0" stroke="var(--ink)" strokeWidth="6" strokeLinecap="round" />
    <circle cx="62" cy="100" r="7" fill="var(--accent)" opacity="0.35" />
    <circle cx="138" cy="100" r="7" fill="var(--accent)" opacity="0.35" />
    <path d="M160 40l12-12M168 66h18M34 44L22 32" stroke="var(--accent)" strokeWidth="6" strokeLinecap="round" />
    <path d="M150 150l10 10M160 150l-10 10" stroke="var(--mint)" strokeWidth="5" strokeLinecap="round" />
  </svg>
);
