/*
 * csv.js —— 极简 CSV 解析（支持引号转义、CRLF、空行、BOM）。
 * 浏览器挂 window.CSVUtil，Node 下可 require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CSVUtil = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // 解析为 {header: [...], rows: [[...], ...]}
  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
    const rows = [];
    let field = "", row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { header: [], rows: [] };
    return { header: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
  }

  // 解析为对象数组（键为表头）
  function parseObjects(text) {
    const { header, rows } = parse(text);
    return rows.map((r) => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i] === undefined ? "" : r[i]; });
      return o;
    });
  }

  function escape(v) {
    const s = String(v === null || v === undefined ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(header, rows) {
    const lines = [header.map(escape).join(",")];
    for (const r of rows) lines.push(r.map(escape).join(","));
    return lines.join("\n") + "\n";
  }

  return { parse, parseObjects, toCSV, escape };
});
