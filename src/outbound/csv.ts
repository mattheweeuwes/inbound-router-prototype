// A small RFC 4180 reader, so the rate file needs no dependency. Fields are separated by commas and records by CRLF or LF;
// a quoted field may hold commas, line breaks and doubled quotes. Anything else in a quote's place is an error with its
// line number, because a silently misread rate file would put a wrong figure in an email.

/** Every record as an array of fields. A trailing line break does not make an empty record; a leading BOM is skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let line = 1;
  const endField = () => { row.push(field); field = ''; state = 'start'; };
  const endRecord = () => { endField(); rows.push(row); row = []; };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'quoted') {
      if (c !== '"') { if (c === '\n') line++; field += c; }
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else state = 'closed';
      continue;
    }
    if (c === ',') { endField(); continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      continue;
    }
    if (state === 'closed') throw new Error(`CSV line ${line}: text after a closing quote`);
    if (c === '"') {
      if (state !== 'start') throw new Error(`CSV line ${line}: a quote inside an unquoted field`);
      state = 'quoted';
      continue;
    }
    field += c;
    state = 'plain';
  }
  if (state === 'quoted') throw new Error(`CSV line ${line}: a quoted field is never closed`);
  if (state !== 'start' || field !== '' || row.length) endRecord();
  return rows;
}

/** The records keyed by the header row. Every record must have as many fields as the header. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((r, i) => {
    if (r.length !== header.length) throw new Error(`CSV record ${i + 1}: ${r.length} fields, the header has ${header.length}`);
    return Object.fromEntries(header.map((h, k) => [h, r[k]]));
  });
}
