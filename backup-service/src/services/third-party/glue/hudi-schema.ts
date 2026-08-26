import avro from 'avsc';
import { Readable } from 'stream';
import { IDestinationConfig } from '../../../models';
import { listS3Objects, downloadFromS3 } from '../../destination/s3';
import { IGlueColumnDef } from './index';

// ---------------------------------------------------------------------------
// Reads a Hudi table's schema straight from the `.hoodie/` metadata that Spark
// committed on S3 — never guesses. This is the authoritative source: the Glue
// table we build from it always matches what Spark actually wrote (data columns,
// the _hoodie_* meta columns, partition fields, and any complex type). This is
// what makes schema evolution free on the Node side: the delta table's
// change_data went from MAP<STRING,STRUCT<old,new>> to a JSON string, and it
// gained delta_id / is_schema_change / schema_change_type, with no change here.
//
// Source of truth, in order:
//   1. The latest completed commit's Avro schema (`.hoodie/<instant>.commit`,
//      `extraMetadata.schema`) — reflects the most recent schema evolution.
//   2. Fallback: `hoodie.table.create.schema` in `.hoodie/hoodie.properties`.
// Partition fields come from `hoodie.table.partition.fields` in hoodie.properties.
// ---------------------------------------------------------------------------

export interface IHudiTableSchema {
  // Data columns for the Glue StorageDescriptor (partition fields excluded).
  columns: IGlueColumnDef[];
  // Partition columns for Glue PartitionKeys (empty for non-partitioned tables).
  partitionKeys: { name: string; type: string }[];
}

// Minimal Avro type shape — a type is a primitive string, a union array, or a
// complex-type object ({ type: 'record' | 'array' | 'map' | ... }).
type AvroType = string | AvroType[] | { type: any; [k: string]: any };

// Maps an Avro type to its Hive/Glue type string. Recursive so nested records,
// arrays, and maps (e.g. change_data) resolve to struct<>/array<>/map<> exactly.
const avroToHive = (t: AvroType): string => {
  // Union — Hudi makes every nullable field ["null", X]. Resolve to the first
  // non-null branch (Hive columns are implicitly nullable).
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null');
    return avroToHive(nonNull.length ? nonNull[0] : 'string');
  }

  if (typeof t === 'string') {
    switch (t) {
      case 'string':
        return 'string';
      case 'boolean':
        return 'boolean';
      case 'int':
        return 'int';
      case 'long':
        return 'bigint';
      case 'float':
        return 'float';
      case 'double':
        return 'double';
      case 'bytes':
        return 'binary';
      // A named-type reference we can't resolve here — safe default.
      default:
        return 'string';
    }
  }

  // Complex / logical types.
  const logical = t.logicalType;
  if (logical === 'timestamp-millis' || logical === 'timestamp-micros') {
    return 'timestamp';
  }
  if (logical === 'date') {
    return 'date';
  }
  if (logical === 'decimal') {
    return `decimal(${t.precision ?? 10},${t.scale ?? 0})`;
  }

  switch (t.type) {
    case 'record': {
      const fields = (t.fields ?? []).map((f: any) => `${f.name}:${avroToHive(f.type)}`).join(',');
      return `struct<${fields}>`;
    }
    case 'array':
      return `array<${avroToHive(t.items)}>`;
    case 'map':
      // Avro map keys are always strings.
      return `map<string,${avroToHive(t.values)}>`;
    case 'enum':
      return 'string';
    case 'fixed':
      return 'binary';
    default:
      // e.g. { type: 'long', logicalType: ... } already handled above; otherwise
      // recurse on the inner type.
      return avroToHive(t.type);
  }
};

// Parses `key=value` lines from a hoodie.properties file into a flat map.
const parseHoodieProperties = (raw: string): Record<string, string> => {
  const props: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return props;
};

// Turns a parsed Avro record schema into Glue columns, excluding any field that
// is a partition column (Hive forbids a column from being both).
const avroRecordToColumns = (avroSchema: any, partitionFieldSet: Set<string>): IGlueColumnDef[] => {
  const fields: any[] = avroSchema?.fields ?? [];
  return fields
    .filter((f) => !partitionFieldSet.has(String(f.name).toLowerCase()))
    .map((f) => ({ name: f.name, type: avroToHive(f.type) }));
};

// Hudi table version 8+ (timeline layout v2) serializes completed commit metadata as
// a binary Avro Object Container File instead of the plain JSON older tables use —
// e.g. a table written with hoodie.table.version=9 commits as
// `.hoodie/timeline/<instant>_<completionTime>.commit`, OCF-encoded. OCF files start
// with the fixed 4-byte magic "Obj\x01"; anything else is the legacy JSON format.
const isAvroContainerFile = (buf: Buffer): boolean =>
  buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x62 && buf[2] === 0x6a && buf[3] === 0x01;

// Decodes an Avro OCF commit file's single HoodieCommitMetadata record. The writer
// schema is read straight from the file's own header (avsc's BlockDecoder handles
// that), so this works regardless of Hudi's exact record shape.
const decodeAvroCommitMetadata = (buf: Buffer): Promise<any> =>
  new Promise((resolve, reject) => {
    let record: any;
    const decoder = new avro.streams.BlockDecoder();
    decoder.on('data', (data: any) => {
      record = data;
    });
    decoder.on('end', () => resolve(record));
    decoder.on('error', reject);
    Readable.from(buf).pipe(decoder);
  });

// Reads and returns the committed schema for a Hudi table rooted at `tableRootKey`
// (an S3 key prefix, no bucket, ending in '/'). Throws when no schema can be
// found — the caller treats that as "table not ready / not written yet".
export const readHudiTableSchema = async (
  destConfig: IDestinationConfig,
  tableRootKey: string
): Promise<IHudiTableSchema> => {
  const hoodieDir = `${tableRootKey}.hoodie/`;
  // `.hoodie/metadata/` is Hudi's own internal metadata table (file listing,
  // column stats, bloom filters, record/secondary index) — a self-contained
  // Hudi table with its own nested `.hoodie/` timeline and its own unrelated
  // schema (key, type, filesystemMetadata, ...). It must never be mistaken
  // for the main table's commits, so it's excluded before anything else
  // looks at `keys`.
  const metadataTableDir = `${hoodieDir}metadata/`;
  const keys = (await listS3Objects(destConfig, hoodieDir)).filter(
    (k) => !k.startsWith(metadataTableDir)
  );

  if (keys.length === 0) {
    throw new Error(`no .hoodie metadata under ${hoodieDir}`);
  }

  // Partition fields from hoodie.properties (authoritative for the layout).
  let partitionFields: string[] = [];
  let createSchema: string | undefined;
  const propsKey = keys.find((k) => k.endsWith('/hoodie.properties'));
  if (propsKey) {
    const buf = await downloadFromS3(destConfig, propsKey);
    if (buf) {
      const props = parseHoodieProperties(buf.toString('utf8'));
      partitionFields = (props['hoodie.table.partition.fields'] ?? '')
        .split(',')
        .map((f) => f.split(':')[0].trim()) // strip any `field:TYPE` annotation
        .filter(Boolean);
      createSchema = props['hoodie.table.create.schema'];
    }
  }

  // Latest completed CoW commit. Legacy tables (timeline layout v1) commit flat as
  // `.hoodie/<instant>.commit`; timeline layout v2 (table version 8+) commits under
  // `.hoodie/timeline/<instant>_<completionTime>.commit` — both are matched here since
  // listS3Objects already lists recursively. Instants are fixed-width digit timestamps,
  // so ascending key sort is also chronological order — the last match is the newest.
  const commitKeys = keys.filter((k) => /\/[\d_]+\.commit$/.test(k));
  let avroSchemaRaw: string | undefined = createSchema;
  if (commitKeys.length > 0) {
    const latestCommitKey = commitKeys[commitKeys.length - 1];
    const buf = await downloadFromS3(destConfig, latestCommitKey);
    if (buf) {
      const commit = isAvroContainerFile(buf)
        ? await decodeAvroCommitMetadata(buf)
        : JSON.parse(buf.toString('utf8'));
      const schemaFromCommit = commit?.extraMetadata?.schema;
      if (schemaFromCommit) {
        avroSchemaRaw = schemaFromCommit;
      }
    }
  }

  if (!avroSchemaRaw) {
    throw new Error(`no Avro schema in commit metadata or hoodie.properties under ${hoodieDir}`);
  }

  // The schema may be a JSON string (escaped) or already an object.
  const avroSchema = typeof avroSchemaRaw === 'string' ? JSON.parse(avroSchemaRaw) : avroSchemaRaw;

  const partitionFieldSet = new Set(partitionFields.map((f) => f.toLowerCase()));
  const columns = avroRecordToColumns(avroSchema, partitionFieldSet);

  if (columns.length === 0) {
    throw new Error(`resolved 0 columns from schema under ${hoodieDir}`);
  }

  // Partition columns are strings in Hive (Hudi partition paths are string-valued).
  const partitionKeys = partitionFields.map((name) => ({ name, type: 'string' }));

  return { columns, partitionKeys };
};
