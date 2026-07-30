import { IS3Config } from '../models';
import { downloadFromS3, listS3Objects, uploadToS3 } from '../services/third-party/s3-bucket';

export interface TransformCsvFolderParams {
  s3Config: IS3Config;
  sourceFolderKey: string;
  destinationFolderKey: string;
  transform: (csvContent: string, sourceKey: string) => string | Promise<string>;
  // Optional — defaults to keeping the source file's own name. Lets a caller
  // normalize the destination filename (e.g. force a .csv extension) without
  // needing its own copy of the download/upload loop.
  mapDestinationFileName?: (sourceFileName: string, sourceKey: string) => string;
}

export const transformCsvFolder = async (
  params: TransformCsvFolderParams
): Promise<string[]> => {
  const { s3Config, sourceFolderKey, destinationFolderKey, transform, mapDestinationFileName } = params;

  const keys = await listS3Objects(s3Config, sourceFolderKey);
  if (!keys.length) {
    throw new Error(`No files found under ${sourceFolderKey}`);
  }

  const writtenKeys: string[] = [];
  for (const key of keys) {
    const buffer = await downloadFromS3(s3Config, key);
    if (!buffer) {
      // Deleted between list and download — skip rather than fail the whole batch.
      continue;
    }

    const transformed = await transform(buffer.toString('utf8'), key);

    const sourceFileName = key.split('/').pop()!;
    const fileName = mapDestinationFileName ? mapDestinationFileName(sourceFileName, key) : sourceFileName;
    const destinationKey = `${destinationFolderKey}/${fileName}`;
    await uploadToS3(s3Config, destinationKey, Buffer.from(transformed, 'utf8'));
    writtenKeys.push(destinationKey);
  }

  return writtenKeys;
};

// Strips any existing extension and appends .csv — used to guarantee the
// uploaded file always ends in .csv regardless of what the source key was
// named (Bulk API export files aren't always named with an extension).
const toCsvFileName = (fileName: string): string => `${fileName.replace(/\.[^./]+$/, '')}.csv`;

// Splits one CSV line into fields, honoring quoted fields that contain commas
// or escaped ("") quotes. Doesn't handle a newline embedded inside a quoted
// field — same accepted limitation as the row splitting elsewhere in this
// pipeline (the file is already split into lines by '\n' before this runs).
const parseCsvRow = (line: string): string[] => {
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

// Double-quotes a cell (escaping internal quotes) when it contains a comma,
// quote, or newline — same convention as recordsToCsv's escapeCell.
const escapeCsvCell = (value: string): string =>
  value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')
    ? `"${value.replace(/"/g, '""')}"`
    : value;

// Removes the named columns (matched case-insensitively against the header
// row) from every row of a CSV, preserving the remaining columns' order.
// Column names that don't exist in the header are silently ignored.
export const removeCsvColumns = (csvContent: string, columnsToRemove: string[]): string => {
  const lines = csvContent.split('\n').filter((line) => line.trim().length > 0);
  if (!lines.length || !columnsToRemove.length) {
    return csvContent;
  }

  const removeSet = new Set(columnsToRemove.map((c) => c.trim().toLowerCase()));
  const headerFields = parseCsvRow(lines[0]);
  const keepIndexes = headerFields
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => !removeSet.has(header.trim().toLowerCase()))
    .map(({ index }) => index);

  return lines
    .map((line) => {
      const fields = parseCsvRow(line);
      return keepIndexes.map((index) => escapeCsvCell(fields[index] ?? '')).join(',');
    })
    .join('\n');
};

// Downloads every CSV under sourceFolderKey, strips columnsToRemove from each
// one, and re-uploads the result under destinationFolderKey — a ready-to-call
// wrapper around transformCsvFolder for this one specific operation.
//
// A source folder with no files (transformCsvFolder throws "No files found
// under ...") or any other failure is logged and swallowed rather than thrown,
// returning an empty array instead — so a caller processing several restore
// objects one at a time can keep going past one empty/missing object folder.
export const removeCsvColumnsInFolder = async (params: {
  s3Config: IS3Config;
  sourceFolderKey: string;
  destinationFolderKey: string;
  columnsToRemove: string[];
}): Promise<string[]> => {
  const { s3Config, sourceFolderKey, destinationFolderKey, columnsToRemove } = params;

  try {
    return await transformCsvFolder({
      s3Config,
      sourceFolderKey,
      destinationFolderKey,
      transform: (csvContent) => removeCsvColumns(csvContent, columnsToRemove),
      mapDestinationFileName: (sourceFileName) => toCsvFileName(sourceFileName),
    });
  } catch (error: any) {
    console.error(`[removeCsvColumnsInFolder] skipping ${sourceFolderKey}: ${error?.message ?? error}`);
    return [];
  }
};
