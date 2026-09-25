// Splits one CSV line into fields, honoring quoted fields that contain commas
// or escaped ("") quotes. Doesn't handle a newline embedded inside a quoted
// field — same accepted limitation as the row splitting elsewhere in this
// pipeline (the file is already split into lines by '\n' before this runs).
export const parseCsvRow = (line: string): string[] => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
};
