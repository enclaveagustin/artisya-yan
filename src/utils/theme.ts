export type ThemeChoice = "auto" | "light" | "dark";

const THEME_STORAGE_KEY = "iu_theme";
const ORDER: readonly ThemeChoice[] = ["auto", "light", "dark"];

export function getInitialTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return ORDER.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : "auto";
  } catch {
    return "auto";
  }
}

/** "auto" follows the system setting (no attribute); light/dark force it. */
export function applyTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  if (theme === "auto") {
    root.removeAttribute("data-iu-theme");
  } else {
    root.setAttribute("data-iu-theme", theme);
  }
}

export function saveTheme(theme: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable; the choice just won't persist.
  }
}

export function nextTheme(current: ThemeChoice): ThemeChoice {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
}

export const THEME_ICON: Record<ThemeChoice, string> = { auto: "◐", light: "☀", dark: "☾" };
