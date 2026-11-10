/**
 * Self-check for the retry gate and the semaphore. No framework, no network. Run:
 *   npx ts-node --files src/services/common/retry.check.ts
 *
 * Proves the review finding is fixed: a retry holds its slot only while it STARTS, so one
 * long-running retry (a range-mode retry can run for hours) cannot block every other retry.
 */
import assert from 'assert';

// scale the timings down; read by constant/index.ts when it is first imported
process.env.MAX_CONCURRENT_RETRIES = '1';
process.env.RETRY_SLOT_HOLD_MS = '50';
process.env.RETRY_BASE_DELAY_MS = '1';
process.env.RETRY_MAX_DELAY_MS = '2';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<void> => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createSemaphore } =
    require('../../utils/semaphore') as typeof import('../../utils/semaphore');
  const { withRetry } = require('./retry') as typeof import('./retry');
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ── semaphore: acquire/release, FIFO, release is idempotent ──────────────────────────
  {
    const s = createSemaphore(1);
    const releaseA = await s.acquire();
    assert.strictEqual(s.active, 1);
    const order: string[] = [];
    const waitB = s.acquire().then((release) => {
      order.push('b');
      return release;
    });
    const waitC = s.acquire().then((release) => {
      order.push('c');
      return release;
    });
    await sleep(5);
    assert.strictEqual(s.waiting, 2);
    releaseA();
    releaseA(); // a second release must not free another caller's slot
    const releaseB = await waitB;
    assert.deepStrictEqual(order, ['b'], 'first come, first served; one slot freed once');
    assert.strictEqual(s.active, 1);
    releaseB();
    (await waitC)();
    assert.strictEqual(s.active, 0);
    // run() still releases when the task throws
    await assert.rejects(() => s.run(async () => Promise.reject(new Error('boom'))), /boom/);
    assert.strictEqual(s.active, 0);
  }

  // ── retry gate: a long retry does not hold the slot for its whole run ────────────────
  {
    const events: string[] = [];
    const flaky = (name: string, retryRunsMs: number) => {
      let attempt = 0;
      return withRetry({
        maxAttempts: 2,
        run: async () => {
          attempt++;
          if (attempt === 1) {
            throw new Error(`${name} first attempt fails`);
          }
          events.push(`${name} retry start`);
          await sleep(retryRunsMs);
          events.push(`${name} retry end`);
        },
      });
    };
    // A's retry runs 400ms; with the old behaviour (slot held for the whole run, 1 slot) B's
    // retry could only start after A's retry ended. Now B starts once A's 50ms hold is over.
    await Promise.all([flaky('A', 400), flaky('B', 10)]);
    assert.ok(
      events.indexOf('B retry start') < events.indexOf('A retry end'),
      `B's retry started while A's long retry was still running: ${events.join(' | ')}`
    );
  }

  // ── retry gate still limits how many retries START together ──────────────────────────
  {
    const starts: number[] = [];
    const t0 = Date.now();
    const burst = (i: number) => {
      let attempt = 0;
      return withRetry({
        maxAttempts: 2,
        run: async () => {
          attempt++;
          if (attempt === 1) {
            throw new Error(`fail ${i}`);
          }
          starts.push(Date.now() - t0);
          await sleep(300); // runs far longer than the hold
        },
      });
    };
    await Promise.all([burst(1), burst(2), burst(3)]);
    starts.sort((a, b) => a - b);
    // one slot, 50ms hold: retries begin roughly 50ms apart instead of all at once
    assert.ok(
      starts[1] - starts[0] >= 40,
      `second retry waited for the first one's hold: ${starts.join(',')}`
    );
    assert.ok(
      starts[2] - starts[1] >= 40,
      `third retry waited for the second one's hold: ${starts.join(',')}`
    );
  }

  console.log('retry.check: OK');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
