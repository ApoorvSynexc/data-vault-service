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
