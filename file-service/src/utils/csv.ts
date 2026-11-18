import { parse } from 'csv-parse';
import { Readable } from 'stream';

type CsvRow = Record<string, string>;

/**
 * Parses a CSV stream (first line = header) and returns an async iterable of
 * rows, one at a time, so large files are never fully buffered in memory.
 * Destroying the source on parse errors is handled by `pipeline` semantics of
 * the returned parser; callers just `for await` over the result.
 */
const parseCsvStream = (source: Readable): AsyncIterable<CsvRow> => {
  const parser = parse({
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_quotes: true,
  });
  source.on('error', (err) => parser.destroy(err));
  parser.on('close', () => source.destroy());
  return source.pipe(parser) as AsyncIterable<CsvRow>;
};

export { parseCsvStream, CsvRow };
