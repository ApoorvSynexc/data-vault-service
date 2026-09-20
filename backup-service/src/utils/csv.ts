// ---------------------------------------------------------------------------
// RFC 4180-compliant CSV parsing/re-serialization for Salesforce Bulk API
// results, shared by every pipeline that writes a raw_csv row to S3 (schedule
// backup's classify-and-split path, schedule backup's raw upload, and
// archival-v2's upload — see their bulk.ts callers).
//
// Why this exists: the Glue raw_csv table (backup-service/glue/index.ts) is
// TextInputFormat + OpenCSVSerde — Athena/Hive splits the file into "rows" by
// physical newline BEFORE the SerDe ever sees a quote character. A quoted
// Salesforce field containing an embedded \n or \r (a multi-line
// MailingStreet, for example) is perfectly valid CSV, but it silently splits
// one logical record into two physical lines: every column after the break
// comes back NULL on the truncated first line, and the leftover second line
// reads back as a phantom row with garbage in its leading columns. Neither
// half can be fixed at query time (see athena-fetch.ts's NON_BLANK_ID guard,
// which only catches a fully-blank phantom line, not this).
//
// parseCSVRecords parses correctly (it is newline/quote-aware); toSingleLineCsv
// re-serializes each record onto exactly one physical line, flattening any
// embedded newline inside a field to a space so the row can never be split by
// Athena's line-oriented reader again.
// ---------------------------------------------------------------------------

export interface ICSVRecord {
  raw: string;
  fields: string[];
}

// Returns each record as { raw, fields } where raw is the original text of the
// record (no trailing newline) and fields is the array of unquoted field
// values. Handles quoted fields with embedded commas, embedded newlines,
// escaped double-quotes (""), and both LF and CRLF line endings. Blank lines
// are skipped.
export const parseCSVRecords = (text: string): ICSVRecord[] => {
  const records: ICSVRecord[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const recordStart = i;
    const fields: string[] = [];
    let field = '';
    let inQuotes = false;
    let contentEnd = -1;

    while (i < len) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"' && i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (ch === '"') {
          inQuotes = false;
          i++;
        } else {
          field += ch;
          i++;
        }
      } else if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        fields.push(field);
        field = '';
        i++;
      } else if (ch === '\r' && i + 1 < len && text[i + 1] === '\n') {
        contentEnd = i;
        fields.push(field);
        i += 2;
        break;
      } else if (ch === '\n') {
        contentEnd = i;
        fields.push(field);
        i++;
        break;
      } else {
        field += ch;
        i++;
      }
    }

    // End of input without a trailing newline
    if (contentEnd === -1) {
      contentEnd = len;
      if (fields.length > 0 || field !== '') {
        fields.push(field);
      }
    }

    // Skip blank records (empty line)
    if (!(fields.length === 1 && fields[0] === '') && fields.length > 0) {
      records.push({ raw: text.slice(recordStart, contentEnd), fields });
    }
  }

  return records;
};

// ponytail: flattens an embedded newline to a single space rather than
// preserving it (e.g. via an escaped "\n" literal) — the row-per-line CSV
// storage format this table uses has no way to carry a real newline through
// at all, so something has to give. A restore writes the field back
// single-line instead of multi-line; every other column on the row (lost
// entirely today) round-trips correctly. Upgrade path: move raw pending
// storage off line-delimited CSV (e.g. NDJSON) if exact multi-line field
// content ever needs to survive a restore.
const flattenField = (value: string): string => value.replace(/\r\n|\r|\n/g, ' ');

// Salesforce's own CSV export quotes every field unconditionally (even empty
// ones), so match that shape rather than only quoting when strictly required.
const quoteField = (value: string): string => `"${flattenField(value).replace(/"/g, '""')}"`;

export const toSingleLineCsv = (fields: string[]): string => fields.map(quoteField).join(',');

// Parses then re-serializes a whole CSV page, guaranteeing one physical line
// per logical record — for callers that don't need to classify rows, just
// write them safely (schedule backup's raw upload, archival's upload).
export const sanitizeCsvText = (text: string): string =>
  parseCSVRecords(text)
    .map(({ fields }) => toSingleLineCsv(fields))
    .join('\n');
