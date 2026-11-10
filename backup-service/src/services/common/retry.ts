import { RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS, RETRY_SLOT_HOLD_MS } from '../../constant';
import { retrySlots } from './concurrency';

// "Equal jitter" exponential backoff: half the exponential delay is fixed, half is
// random, so simultaneous failures spread out instead of retrying in lockstep.
export const backoffDelayMs = (
  attempt: number,
  baseMs: number = RETRY_BASE_DELAY_MS,
  maxMs: number = RETRY_MAX_DELAY_MS
): number => {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface IWithRetryOptions<T> {
  maxAttempts: number;
  run: () => Promise<T>;
  // Return false to stop retrying and rethrow immediately. May be async so a
  // caller can persist a terminal state before giving up.
  shouldRetry?: (err: unknown) => boolean | Promise<boolean>;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

// Runs `run`, retrying failures up to `maxAttempts` times in total. The first
// attempt runs immediately; every retry waits an exponentially growing, jittered
// delay and then takes a retrySlot, so at most MAX_CONCURRENT_RETRIES retries
// execute at once across the whole process.
// Starts a retry attempt through the retry gate. The slot is held for RETRY_SLOT_HOLD_MS (or
// until the attempt ends, if sooner), NOT for the whole attempt: a retry can run for hours
// and must not block every other retry. What is bounded is how many retries START together.
const runRetryAttempt = async <T>(run: () => Promise<T>): Promise<T> => {
  const release = await retrySlots.acquire();
  const timer = setTimeout(release, RETRY_SLOT_HOLD_MS);
  timer.unref();
  try {
    return await run();
  } finally {
    clearTimeout(timer);
    release();
  }
};

export const withRetry = async <T>(options: IWithRetryOptions<T>): Promise<T> => {
  const { maxAttempts, run, shouldRetry, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return attempt === 1 ? await run() : await runRetryAttempt(run);
    } catch (err) {
      if (shouldRetry && !(await shouldRetry(err))) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts) {
        const delayMs = backoffDelayMs(attempt);
        onRetry?.(attempt, err, delayMs);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
};
