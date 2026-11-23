import { strFromU8, unzipSync } from "fflate";

/**
 * Opens the ZIP that Instagram's "Download your information" gives you and picks out the three lists the checker
 * needs, so nothing has to be unzipped or renamed by hand. Everything else in the ZIP (photos, messages, ...) is never
 * even decompressed.
 */

export interface ZipExportFile {
  /** File name without folders, e.g. "followers_1.html". */
  readonly name: string;
  readonly text: string;
}

export interface ZipExportResult {
  readonly files: readonly ZipExportFile[];
  /** The day written in the ZIP's file name (instagram-user-2026-11-23-xxxx.zip), if there is one. */
  readonly day: string;
}

/** The only files read: following, followers (one or several parts) and recently unfollowed, as HTML or JSON. */
const WANTED = /^(following|followers(_\d+)?|recently_unfollowed_profiles)\.(html|json)$/i;
const FOLDER = "followers_and_following";

/** One list file is a few MB at most; anything bigger is not what we are looking for. */
const MAX_ENTRY_BYTES = 60 * 1024 * 1024;
const MAX_FILES = 40;

/** A ZIP with photos and messages can be gigabytes; reading that into memory would freeze the tab. */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export const isZipName = (name: string): boolean => /\.zip$/i.test(name);

export function dayFromZipName(name: string): string {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(name);
  return match === null ? "" : match[1];
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const isWanted = (path: string): boolean => {
  const clean = path.replace(/\\/g, "/");
  if (clean.endsWith("/") || clean.split("/").some(part => part === ".." || part === "__MACOSX")) {
    return false;
  }
  return clean.split("/").slice(0, -1).includes(FOLDER) && WANTED.test(baseName(clean));
};

export function readExportZip(bytes: Uint8Array, zipName: string = ""): ZipExportResult {
  let found: Record<string, Uint8Array>;
  try {
    found = unzipSync(bytes, {
      filter: entry => isWanted(entry.name) && entry.originalSize <= MAX_ENTRY_BYTES,
    });
  } catch {
    throw new Error("This is not a valid ZIP file (or it is damaged). Download the export from Instagram again.");
  }
  const paths = Object.keys(found).sort();
  if (paths.length > MAX_FILES) {
    throw new Error("This ZIP contains too many list files to be an Instagram export.");
  }
  const files = paths.map(path => ({ name: baseName(path.replace(/\\/g, "/")), text: strFromU8(found[path]) }));
  return { files, day: dayFromZipName(zipName) };
}
