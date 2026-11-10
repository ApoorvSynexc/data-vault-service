export interface ISemaphore {
  // Runs `task` once a slot is free and releases the slot when it settles,
  // whether it resolved or threw. Waiters are served first-in, first-out.
  run: <T>(task: () => Promise<T>) => Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

export const createSemaphore = (limit: number): ISemaphore => {
  const maxSlots = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < maxSlots) {
      active++;
      return;
    }
    // The slot is handed straight to the next waiter in release(), so `active`
    // is never decremented-then-incremented and a new caller cannot jump the queue.
    await new Promise<void>((resolve) => waiters.push(resolve));
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  };

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
};
