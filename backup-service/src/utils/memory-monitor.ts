import v8 from 'v8';
import { logger } from '../middlewares/logger';
import { jobSlots, pageSlots } from '../services/common/concurrency';

const LOG_INTERVAL_MS = 60 * 1000;
const WARN_HEAP_RATIO = 0.8;

const toMb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

// Logs one line per minute: process memory next to the job/page semaphore state.
// Lets you see in CloudWatch which workload (active jobs / pages) the heap grew
// with, and whether it keeps climbing while idle (= a real leak, not load).
export const startMemoryMonitor = (): void => {
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    const ratio = mem.heapUsed / heapLimit;

    const line =
      `[MEM] rss=${toMb(mem.rss)}MB heapUsed=${toMb(mem.heapUsed)}MB heapLimit=${toMb(heapLimit)}MB ` +
      `external=${toMb(mem.external)}MB arrayBuffers=${toMb(mem.arrayBuffers)}MB | ` +
      `jobs active=${jobSlots.active} waiting=${jobSlots.waiting} | ` +
      `pages active=${pageSlots.active} waiting=${pageSlots.waiting}`;

    if (ratio >= WARN_HEAP_RATIO) {
      logger.warn(`${line} | HEAP AT ${Math.round(ratio * 100)}% OF LIMIT`);
    } else {
      logger.info(line);
    }
  }, LOG_INTERVAL_MS);

  // Must never keep the process alive on shutdown.
  timer.unref();
};
