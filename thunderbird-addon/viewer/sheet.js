// Spreadsheet renderer: the host parses the workbook (SheetJS) and sends a
// grid per sheet; this draws it with frozen headers, merges and sheet tabs.
const columnName = (index) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

export async function render(stage, file, { host, setToolbar, h, icon, iconButton }) {
  const { sheets } = await host(`/v1/fs/sheet?path=${encodeURIComponent(file.path)}`);
  let active = 0;
  let cell = null;
  const wrap = h("div.sheet-wrap");
  const tabs = h("div.sheet-tabs", { role: "tablist" });
  const address = h("span.label", {});
  const formula = h("span.label", { style: { fontFamily: "var(--mw-font-mono)" } });
  const findInput = h("input.input.find-input", { placeholder: "Find in sheet", "aria-label": "Find in sheet" });
  stage.replaceChildren(wrap, tabs);

  function draw() {
    const sheet = sheets[active];
    const table = h("table.grid");
    const colgroup = h("colgroup", {}, h("col", { style: { width: "48px" } }), ...Array.from({ length: sheet.cols }, (_, c) => h("col", { style: { width: `${Math.max(64, Math.min(420, sheet.widths?.[c] ?? 96))}px` } })));
    const head = h("tr", {}, h("th", {}, ""), ...Array.from({ length: sheet.cols }, (_, c) => h("th", {}, columnName(sheet.origin.c + c))));
    const covered = new Set();
    const spans = new Map(sheet.merges.map((m) => [`${m.r}:${m.c}`, m]));
    for (const m of sheet.merges) for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) covered.add(`${r}:${c}`);
    const body = h("tbody");
    sheet.rows.forEach((row, r) => {
      const tr = h("tr", {}, h("th", {}, String(sheet.origin.r + r + 1)));
      for (let c = 0; c < sheet.cols; c++) {
        if (covered.has(`${r}:${c}`)) continue;
        const value = row[c];
        const span = spans.get(`${r}:${c}`);
        const td = h(`td${value?.n ? ".num" : ""}${value?.s?.bold ? ".bold" : ""}${value?.s?.italic ? ".italic" : ""}`, {
          ...(span ? { rowspan: span.rs, colspan: span.cs } : {}),
          dataset: { r, c },
          title: value?.t ?? "",
        }, value?.t ?? "");
        tr.append(td);
      }
      body.append(tr);
    });
    table.append(colgroup, h("thead", {}, head), body);
    wrap.replaceChildren(table);
    tabs.replaceChildren(...sheets.map((s, i) => h("button", { type: "button", role: "tab", "aria-selected": String(i === active), onclick: () => { active = i; cell = null; draw(); } }, s.name)),
      sheet.truncated ? h("span.sheet-note", {}, `Showing ${sheet.rows.length} of ${sheet.total.rows} rows, ${sheet.cols} of ${sheet.total.cols} columns`) : null);
    address.textContent = `${sheet.total.rows} × ${sheet.total.cols}`;
    formula.textContent = "";
  }

  wrap.addEventListener("click", (event) => {
    const td = event.target.closest("td");
    if (!td) return;
    wrap.querySelector("td.active")?.classList.remove("active");
    td.classList.add("active");
    const sheet = sheets[active];
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    cell = { sheet: sheet.name, address: `${columnName(sheet.origin.c + c)}${sheet.origin.r + r + 1}`, value: sheet.rows[r][c]?.t ?? "", formula: sheet.rows[r][c]?.f ?? null };
    address.textContent = cell.address;
    formula.textContent = cell.formula ? `=${cell.formula}` : cell.value;
  });

  const find = (text) => {
    const needle = text.toLowerCase();
    if (!needle) return null;
    for (let i = 0; i < sheets.length; i++) {
      const s = (active + i) % sheets.length;
      const rows = sheets[s].rows;
      for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c]?.t?.toLowerCase().includes(needle)) {
          if (s !== active) { active = s; draw(); }
          const td = wrap.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
          td?.scrollIntoView({ block: "center", inline: "center" });
          td?.click();
          return cell;
        }
      }
    }
    return null;
  };
  findInput.addEventListener("keydown", (event) => { if (event.key === "Enter") find(findInput.value); });

  setToolbar(address, h("span.divider"), formula, h("span.spacer"), h("div.group.search-field", {}, icon("search", { size: 18 }), findInput));
  draw();

  return {
    state: () => ({ sheet: sheets[active].name, sheets: sheets.map((s) => ({ name: s.name, rows: s.total.rows, cols: s.total.cols })), cell }),
    command: (action, args) => {
      if (action === "sheet") { const i = sheets.findIndex((s) => s.name === args.sheet || String(sheets.indexOf(s)) === String(args.sheet)); if (i < 0) throw new Error("No such sheet"); active = i; draw(); return { sheet: sheets[i].name }; }
      if (action === "find") return { found: find(args.text ?? "") };
      if (action === "rows") {
        const s = sheets[active];
        const from = Number(args.from ?? 0);
        return { sheet: s.name, rows: s.rows.slice(from, from + Math.min(Number(args.count ?? 50), 500)).map((row) => row.map((v) => v?.t ?? "")) };
      }
      throw new Error(`Unknown sheet action ${action}`);
    },
  };
}
