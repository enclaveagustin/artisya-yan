import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * A small, dependency-light .xlsx reader/writer for plain text tables: exactly
 * what the whitelist workbook needs (sheets of text cells, a bold header row,
 * clickable links). Opens in Excel, Google Sheets and LibreOffice.
 *
 * Reading understands what Excel and Google Sheets write (shared strings,
 * inline strings, plain values). Formatting, formulas and charts are ignored.
 */

export interface Sheet {
  readonly name: string;
  /** Row-major cell text; row 0 is the header. */
  readonly rows: readonly (readonly string[])[];
}

const MAX_SHEETS = 20;
const MAX_ROWS = 200000;
const MAX_COLUMNS = 50;

const escapeXml = (text: string): string =>
  // Control characters (other than tab/newline) are not allowed in XML 1.0.
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: {
        const code = entity.charAt(1).toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
    }
  });

const columnName = (index: number): string => {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const columnIndex = (letters: string): number => {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
};

// Excel sheet names: max 31 chars, none of  \ / ? * [ ] :
const safeSheetName = (name: string, index: number): string => {
  const cleaned = name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31).trim();
  return cleaned === "" ? `Sheet${index + 1}` : cleaned;
};

const URL_CELL = /^https:\/\/www\.instagram\.com\/[A-Za-z0-9._]{1,30}$/;

function sheetXml(sheet: Sheet): string {
  const width = Math.max(1, ...sheet.rows.map(row => row.length));
  const lastCell = `${columnName(width - 1)}${Math.max(1, sheet.rows.length)}`;
  const cols: string[] = [];
  for (let c = 0; c < width; c++) {
    const longest = Math.max(10, ...sheet.rows.slice(0, 500).map(row => (row[c] ?? "").length));
    cols.push(`<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, longest + 2)}" customWidth="1"/>`);
  }
  const rowsXml = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (value === "") {
            return "";
          }
          const style = r === 0 ? ' s="1"' : "";
          if (r > 0 && URL_CELL.test(value)) {
            // Clickable link; the cached value keeps it readable everywhere.
            const url = escapeXml(value);
            return `<c r="${ref}" t="str"${style}><f>HYPERLINK("${url}","${url}")</f><v>${url}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${lastCell}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols.join("")}</cols>` +
    `<sheetData>${rowsXml}</sheetData>` +
    `<autoFilter ref="A1:${lastCell}"/>` +
    "</worksheet>"
  );
}

export function writeXlsx(sheets: readonly Sheet[]): Uint8Array {
  const named = sheets.map((sheet, i) => ({ ...sheet, name: safeSheetName(sheet.name, i) }));
  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      named
        .map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("") +
      "</Types>",
  );
  files["_rels/.rels"] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
  );
  files["xl/workbook.xml"] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheets>" +
      named.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>",
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      named
        .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>",
  );
  files["xl/styles.xml"] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs>' +
      "</styleSheet>",
  );
  named.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet));
  });
  return zipSync(files, { level: 6 });
}

// --- reading -----------------------------------------------------------------

const attr = (tag: string, name: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return match === null ? null : decodeXml(match[1]);
};

const textRuns = (xml: string): string => {
  const parts: string[] = [];
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutPhonetic)) !== null) {
    parts.push(decodeXml(m[1] ?? ""));
  }
  return parts.join("");
};

function readSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) {
    return [];
  }
  const strings: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    strings.push(textRuns(m[1] ?? ""));
  }
  return strings;
}

function readSheet(xml: string, shared: readonly string[]): string[][] {
  const grid: string[][] = [];
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml)) !== null) {
    const ref = attr(m[1], "r");
    const ref2 = ref === null ? null : /^([A-Z]{1,3})(\d{1,7})$/.exec(ref);
    if (ref2 === null) {
      continue;
    }
    const col = columnIndex(ref2[1]);
    const row = parseInt(ref2[2], 10) - 1;
    if (row >= MAX_ROWS || col >= MAX_COLUMNS) {
      continue;
    }
    const type = attr(m[1], "t");
    const body = m[2] ?? "";
    let value = "";
    if (type === "inlineStr") {
      value = textRuns(body);
    } else {
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      const raw = v === null ? "" : decodeXml(v[1]);
      value = type === "s" ? shared[parseInt(raw, 10)] ?? "" : raw;
    }
    if (value === "") {
      continue;
    }
    while (grid.length <= row) {
      grid.push([]);
    }
    const cells = grid[row];
    while (cells.length <= col) {
      cells.push("");
    }
    cells[col] = value;
  }
  return grid;
}

export function readXlsx(bytes: Uint8Array): Sheet[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("This file is not a valid .xlsx workbook.");
  }
  const text = (path: string): string | undefined => (files[path] === undefined ? undefined : strFromU8(files[path]));
  const workbook = text("xl/workbook.xml");
  if (workbook === undefined) {
    throw new Error("This file is not a valid .xlsx workbook (no xl/workbook.xml).");
  }
  const relsXml = text("xl/_rels/workbook.xml.rels") ?? "";
  const targets: Record<string, string> = {};
  const relRe = /<Relationship\b[^>]*>/g;
  let rel: RegExpExecArray | null;
  while ((rel = relRe.exec(relsXml)) !== null) {
    const id = attr(rel[0], "Id");
    const target = attr(rel[0], "Target");
    if (id !== null && target !== null) {
      targets[id] = target.charAt(0) === "/" ? target.slice(1) : `xl/${target}`;
    }
  }
  const shared = readSharedStrings(text("xl/sharedStrings.xml"));

  const sheets: Sheet[] = [];
  const sheetRe = /<sheet\b[^>]*>/g;
  let tag: RegExpExecArray | null;
  while ((tag = sheetRe.exec(workbook)) !== null && sheets.length < MAX_SHEETS) {
    const name = attr(tag[0], "name");
    const rid = attr(tag[0], "r:id");
    const path = rid === null ? undefined : targets[rid];
    const xml = path === undefined ? undefined : text(path);
    if (name === null || xml === undefined) {
      continue;
    }
    sheets.push({ name, rows: readSheet(xml, shared) });
  }
  return sheets;
}
