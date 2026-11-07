export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += ch;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) rows.push([...row, field]);
  const headers = rows.shift() ?? [];
  return { headers, rows: rows.map(values => Object.fromEntries(headers.map((header, i) => [header, values[i]]))) };
}
