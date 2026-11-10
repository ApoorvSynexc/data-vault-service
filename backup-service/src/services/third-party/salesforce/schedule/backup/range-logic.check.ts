/**
 * Self-check for the range-export logic. No framework, no Salesforce, no DynamoDB — only the
 * pure functions in range-logic.ts. Run:
 *   npx ts-node --files src/services/third-party/salesforce/schedule/backup/range-logic.check.ts
 *
 * Covers what silently loses or duplicates data if wrong:
 *   1. Boundaries come from the Id stream in order; ranges tile it with open first/last ends.
 *   2. Halving: leaves tile the parent, ids sort in Id order, repeated down to the floor.
 *   3. Failure decisions (split vs fail), the learned size and pre-splitting.
 *   4. Resume selection and roll-up totals.
 *   5. SOQL: user filter grouped, Id bounds, nothing but real Ids accepted.
 */
import assert from 'assert';
import { JOB_OBJECT_STATUS, STATUS } from '../../../../../constant';
import { IBackupRange } from '../../../../../models';
import {
  BoundaryCollector,
  aggregateRanges,
  assertSalesforceId,
  buildIdOnlySoql,
  buildIncrementalConditions,
  buildRangeSoql,
  buildRanges,
  decideSizeFailure,
  initialRangeId,
  isDeterministicQueryError,
  learnedSizeAfterFailure,
  mergeBoundaries,
  parseIdColumn,
  pickNextRange,
  rangePageSize,
  shouldPreSplit,
  splitIdsIntoLeaves,
} from './range-logic';

const idAt = (n: number): string => `001${String(n).padStart(15, '0')}`; // 18 chars, ordered
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => idAt(i));
const range = (rangeId: string, over: Partial<IBackupRange> = {}): IBackupRange => ({
  backupJobId: 'job',
  rangeKey: `obj#${rangeId}`,
  objectKey: 'obj',
  rangeId,
  startId: null,
  endId: null,
  expectedRows: 100,
  status: STATUS.pending,
  updatedAt: 'now',
  ...over,
});

// ─── 1. boundaries and ranges ─────────────────────────────────────────────────────────
{
  const collector = new BoundaryCollector(4);
  collector.push([0, 1, 2].map(idAt)); // Ids arrive in pages, as Bulk result pages do
  collector.push([3, 4, 5, 6, 7].map(idAt));
  collector.push([8, 9].map(idAt));
  assert.strictEqual(collector.total, 10);
  assert.deepStrictEqual(collector.boundaries, [
    { id: idAt(4), index: 4 },
    { id: idAt(8), index: 8 },
  ]);
  const ranges = buildRanges({
    backupJobId: 'job',
    objectKey: 'obj',
    boundaries: collector.boundaries,
    total: collector.total,
    now: 'now',
  });
  assert.deepStrictEqual(
    ranges.map((r) => [r.rangeId, r.startId, r.endId, r.expectedRows]),
    [
      ['r000', null, idAt(4), 4], // open at the start
      ['r001', idAt(4), idAt(8), 4],
      ['r002', idAt(8), null, 2], // open at the end: records created during the run are included
    ]
  );
  for (let i = 0; i < ranges.length - 1; i++) {
    assert.strictEqual(ranges[i].endId, ranges[i + 1].startId, 'no gap, no overlap');
  }
  assert.strictEqual(
    ranges.reduce((sum, r) => sum + r.expectedRows, 0),
    10
  );
  assert.ok(ranges.every((r) => r.status === STATUS.pending));
}
{
  // an exact multiple of the range size makes no empty trailing range
  const c = new BoundaryCollector(5);
  c.push(ids(10));
  const r = buildRanges({
    backupJobId: 'j',
    objectKey: 'o',
    boundaries: c.boundaries,
    total: c.total,
    now: 'n',
  });
  assert.deepStrictEqual(
    r.map((x) => x.expectedRows),
    [5, 5]
  );
  // smaller than one range: a single range open at both ends
  const small = new BoundaryCollector(100);
  small.push(ids(7));
  assert.deepStrictEqual(small.boundaries, []);
  const only = buildRanges({
    backupJobId: 'j',
    objectKey: 'o',
    boundaries: [],
    total: 7,
    now: 'n',
  });
  assert.deepStrictEqual(
    only.map((x) => [x.startId, x.endId, x.expectedRows]),
    [[null, null, 7]]
  );
}
{
  // capping the number of initial ranges merges boundaries without gaps
  const b = Array.from({ length: 99 }, (_, i) => ({ id: idAt(i + 1), index: (i + 1) * 10 }));
  const merged = mergeBoundaries(b, 64);
  assert.ok(merged.length + 1 <= 64);
  const r = buildRanges({
    backupJobId: 'j',
    objectKey: 'o',
    boundaries: merged,
    total: 1000,
    now: 'n',
  });
  assert.strictEqual(
    r.reduce((s, x) => s + x.expectedRows, 0),
    1000
  );
  assert.strictEqual(mergeBoundaries(b.slice(0, 10), 64).length, 10);
}
assert.strictEqual(initialRangeId(0), 'r000');
assert.strictEqual(initialRangeId(63), 'r063');
assert.deepStrictEqual(
  ['r003b', 'r004', 'r003aa', 'r003', 'r003ab', 'r003a'].sort(),
  ['r003', 'r003a', 'r003aa', 'r003ab', 'r003b', 'r004'],
  'range ids sort in run order as plain strings'
);

// ─── 2. halving ───────────────────────────────────────────────────────────────────────
{
  const parent = { rangeId: 'r003', startId: idAt(0), endId: idAt(100) };
  assert.deepStrictEqual(
    splitIdsIntoLeaves(parent, ids(100), 50).map((l) => [
      l.rangeId,
      l.startId,
      l.endId,
      l.expectedRows,
    ]),
    [
      ['r003a', idAt(0), idAt(50), 50],
      ['r003b', idAt(50), idAt(100), 50],
    ]
  );
  const leaves = splitIdsIntoLeaves(
    { rangeId: 'r001', startId: null, endId: null },
    ids(1000),
    100
  );
  assert.strictEqual(leaves.length, 16);
  assert.strictEqual(leaves[0].startId, null); // keeps the parent's open ends
  assert.strictEqual(leaves[leaves.length - 1].endId, null);
  for (let i = 0; i < leaves.length - 1; i++) {
    assert.strictEqual(leaves[i].endId, leaves[i + 1].startId);
  }
  assert.strictEqual(
    leaves.reduce((s, l) => s + l.expectedRows, 0),
    1000
  );
  const leafIds = leaves.map((l) => l.rangeId);
  assert.deepStrictEqual([...leafIds].sort(), leafIds, 'leaf ids sort in Id order');
  assert.deepStrictEqual(splitIdsIntoLeaves(parent, ids(1), 1), []); // too small to split
  assert.deepStrictEqual(splitIdsIntoLeaves(parent, ids(40), 50), []); // already small enough
  assert.strictEqual(
    splitIdsIntoLeaves(parent, ids(7), 3).reduce((s, l) => s + l.expectedRows, 0),
    7
  );
}
{
  // 1,000,000 rows keep halving until a piece is at most 10,000 rows
  let current = ids(1_000_000);
  const sizes: number[] = [];
  while (current.length > 10_000) {
    const halves = splitIdsIntoLeaves(
      { rangeId: 'r000', startId: null, endId: null },
      current,
      Math.ceil(current.length / 2)
    );
    assert.strictEqual(halves.length, 2);
    sizes.push(halves[0].expectedRows);
    current = current.slice(0, halves[0].expectedRows);
  }
  assert.deepStrictEqual(sizes, [500000, 250000, 125000, 62500, 31250, 15625, 7812]);
}

// ─── 3. failure decisions ─────────────────────────────────────────────────────────────
assert.strictEqual(
  decideSizeFailure({ expectedRows: 200000, failedJobs: 1, totalRanges: 25 }),
  'split'
);
assert.strictEqual(
  decideSizeFailure({ expectedRows: 15625, failedJobs: 3, totalRanges: 60 }),
  'split'
);
assert.strictEqual(
  decideSizeFailure({ expectedRows: 10000, failedJobs: 1, totalRanges: 5 }),
  'fail'
); // the floor
assert.strictEqual(
  decideSizeFailure({ expectedRows: 7812, failedJobs: 1, totalRanges: 5 }),
  'fail'
);
assert.strictEqual(
  decideSizeFailure({ expectedRows: 200000, failedJobs: 21, totalRanges: 5 }),
  'fail'
); // budget
assert.strictEqual(
  decideSizeFailure({ expectedRows: 200000, failedJobs: 20, totalRanges: 5 }),
  'split'
);
assert.strictEqual(
  decideSizeFailure({ expectedRows: 200000, failedJobs: 1, totalRanges: 128 }),
  'fail'
); // cap
assert.ok(isDeterministicQueryError('INVALID_FIELD: No such column Foo__c on entity Account'));
assert.ok(!isDeterministicQueryError('Exceeded max number of retries. Max retry count: 15'));
assert.strictEqual(learnedSizeAfterFailure(200000), 100000);
assert.strictEqual(learnedSizeAfterFailure(15000), 10000); // never below the floor
assert.ok(shouldPreSplit(range('r005', { expectedRows: 200000 }), 100000, 25));
assert.ok(
  !shouldPreSplit(range('r005', { expectedRows: 100000 }), 100000, 25),
  'already at the learned size'
);
assert.ok(
  !shouldPreSplit(range('r005', { expectedRows: 200000 }), undefined, 25),
  'nothing learned yet'
);
assert.ok(
  !shouldPreSplit(range('r005', { expectedRows: 200000, bulkJobId: 'sf1' }), 100000, 25),
  'has a Salesforce job'
);
assert.ok(
  !shouldPreSplit(
    range('r005', { status: JOB_OBJECT_STATUS.transferInProgress, expectedRows: 200000 }),
    100000,
    25
  )
);
assert.ok(
  !shouldPreSplit(range('r005', { expectedRows: 200000 }), 100000, 128),
  'total cap reached'
);
assert.ok(
  !shouldPreSplit(range('r005', { expectedRows: 9000 }), 5000, 10),
  'never below the floor'
);

// ─── 4. resume and totals ─────────────────────────────────────────────────────────────
{
  const ranges = [
    range('r000', { status: JOB_OBJECT_STATUS.uploadCompleted }),
    range('r001', { status: JOB_OBJECT_STATUS.split }),
    range('r001a', { status: JOB_OBJECT_STATUS.uploadCompleted }),
    range('r001b', { status: JOB_OBJECT_STATUS.transferInProgress, currentLocator: 'loc9' }), // crashed mid-upload
    range('r002'),
  ];
  assert.strictEqual(
    pickNextRange(ranges, new Set())?.rangeId,
    'r001b',
    'resume at the first unfinished range'
  );
  assert.strictEqual(
    pickNextRange(ranges, new Set(['obj#r001b']))?.rangeId,
    'r002',
    'a failed range is skipped this run'
  );
  assert.strictEqual(pickNextRange(ranges, new Set(['obj#r001b', 'obj#r002'])), undefined);
  assert.strictEqual(
    pickNextRange([range('r000', { status: JOB_OBJECT_STATUS.failed })], new Set())?.rangeId,
    'r000'
  );
  assert.deepStrictEqual(
    aggregateRanges([
      range('r000', { status: JOB_OBJECT_STATUS.split, completedRecordCount: 999 }), // a split parent never counts
      range('r000a', {
        status: JOB_OBJECT_STATUS.uploadCompleted,
        completedRecordCount: 100,
        sizeInBytes: 1000,
      }),
      range('r000b', {
        status: JOB_OBJECT_STATUS.uploadCompleted,
        completedRecordCount: 50,
        sizeInBytes: 500,
        insertCount: 30,
        updateCount: 15,
        deleteCount: 5,
      }),
      range('r001', { status: JOB_OBJECT_STATUS.transferInProgress, completedRecordCount: 70 }), // not done yet
      range('r002'),
    ]),
    {
      rangesTotal: 4,
      rangesDone: 2,
      completedRecordCount: 150,
      sizeInBytes: 1500,
      insertCount: 30,
      updateCount: 15,
      deleteCount: 5,
    }
  );
}

// ─── 5. SOQL ──────────────────────────────────────────────────────────────────────────
assert.strictEqual(
  buildRangeSoql({
    fieldList: ['Id', 'Name'],
    objectName: 'Account',
    whereClause: "WHERE Type = 'A' OR Type = 'B'",
    startId: idAt(4),
    endId: idAt(8),
  }),
  `SELECT Id, Name FROM Account WHERE (Type = 'A' OR Type = 'B') AND Id >= '${idAt(4)}' AND Id < '${idAt(8)}' WITH USER_MODE`
);
assert.strictEqual(
  buildRangeSoql({ fieldList: ['Id'], objectName: 'Account', startId: null, endId: null }),
  'SELECT Id FROM Account WITH USER_MODE'
);
assert.strictEqual(
  buildRangeSoql({
    fieldList: ['Id'],
    objectName: 'Account',
    whereClause: 'WHERE A = 1 OR B = 2',
    extraConditions: buildIncrementalConditions('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    startId: idAt(1),
    endId: null,
  }),
  `SELECT Id FROM Account WHERE (A = 1 OR B = 2) AND LastModifiedDate >= 2026-01-01T00:00:00Z AND LastModifiedDate < 2026-02-01T00:00:00Z AND Id >= '${idAt(1)}' WITH USER_MODE`
);
{
  const idOnly = buildIdOnlySoql({
    objectName: 'Account',
    whereClause: 'WHERE A = 1',
    startId: null,
    endId: null,
  });
  assert.strictEqual(idOnly, 'SELECT Id FROM Account WHERE (A = 1) ORDER BY Id ASC');
  assert.ok(!/USER_MODE/.test(idOnly));
}
// only real Salesforce Ids can reach a query
assert.strictEqual(assertSalesforceId(idAt(1)), idAt(1));
assert.strictEqual(assertSalesforceId('0015g00000AbCdE'), '0015g00000AbCdE');
assert.throws(() => assertSalesforceId("001' OR Name != '"));
assert.throws(() =>
  buildRangeSoql({ fieldList: ['Id'], objectName: 'A', startId: "x' OR '1'='1", endId: null })
);
assert.deepStrictEqual(parseIdColumn('"Id"\n"001A"\n"001B"\n'), ['001A', '001B']);
assert.deepStrictEqual(parseIdColumn('"Id"\r\n"001A"\r\n\r\n'), ['001A']);
assert.strictEqual(rangePageSize(500), 10000);
assert.strictEqual(rangePageSize(10), 50000);
assert.strictEqual(rangePageSize(100000), 2000);

console.log('range-logic.check: OK');
