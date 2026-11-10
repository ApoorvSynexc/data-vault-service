import { MAX_CONCURRENT_JOBS, MAX_CONCURRENT_PAGES, MAX_CONCURRENT_RETRIES } from '../../constant';
import { createSemaphore } from '../../utils/semaphore';

// Process-wide limits shared by every backup/archival job in this instance.
// jobSlots bounds how many jobs run at once; pageSlots bounds how many
// Salesforce result pages are held in memory at once (fetch -> parse -> upload),
// regardless of how many jobs/objects are running. pageSlots is the hard memory
// bound; jobSlots keeps a burst of jobs from starving each other.
// retrySlots bounds how many *retry* attempts (not first attempts) run at once.
export const jobSlots = createSemaphore(MAX_CONCURRENT_JOBS);
export const pageSlots = createSemaphore(MAX_CONCURRENT_PAGES);
export const retrySlots = createSemaphore(MAX_CONCURRENT_RETRIES);
