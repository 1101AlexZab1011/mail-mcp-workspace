// Spreadsheets (xlsx, xls, ods, csv, …) → a JSON grid the viewer renders:
// displayed cell text, merges, column widths, per sheet. Big sheets are cut
// at a row/column limit and say so.
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";

const MAX_ROWS = 5000;
const MAX_COLS = 200;

export async function readSheet(path) {
  const data = await readFile(path);
  const book = XLSX.read(data, { type: "buffer", cellDates: true, cellStyles: true, dense: false, sheetRows: MAX_ROWS + 1 });
  const sheets = book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const ref = sheet["!ref"];
    if (!ref) return { name, rows: [], cols: 0, merges: [], widths: [], truncated: false };
    const range = XLSX.utils.decode_range(ref);
    const lastRow = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
    const lastCol = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
    const rows = [];
    for (let r = range.s.r; r <= lastRow; r++) {
      const row = [];
      for (let c = range.s.c; c <= lastCol; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (!cell) { row.push(null); continue; }
        const text = cell.w ?? (cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v ?? ""));
        const numeric = cell.t === "n";
        const style = cell.s ? { bold: Boolean(cell.s.font?.bold), italic: Boolean(cell.s.font?.italic) } : undefined;
        row.push({ t: text, n: numeric || undefined, ...(style?.bold || style?.italic ? { s: style } : {}), ...(cell.f ? { f: cell.f } : {}) });
      }
      rows.push(row);
    }
    const widths = (sheet["!cols"] ?? []).slice(range.s.c, lastCol + 1).map((col) => (col?.wpx ? Math.round(col.wpx) : col?.wch ? Math.round(col.wch * 7 + 10) : null));
    const merges = (sheet["!merges"] ?? [])
      .filter((m) => m.s.r <= lastRow && m.s.c <= lastCol)
      .map((m) => ({ r: m.s.r - range.s.r, c: m.s.c - range.s.c, rs: Math.min(m.e.r, lastRow) - m.s.r + 1, cs: Math.min(m.e.c, lastCol) - m.s.c + 1 }));
    return {
      name,
      origin: { r: range.s.r, c: range.s.c },
      rows,
      cols: lastCol - range.s.c + 1,
      widths,
      merges,
      truncated: range.e.r > lastRow || range.e.c > lastCol,
      total: { rows: range.e.r - range.s.r + 1, cols: range.e.c - range.s.c + 1 },
    };
  });
  return { sheets };
}
