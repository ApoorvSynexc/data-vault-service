/**
 * Merges any number of ID arrays into a single deduplicated array.
 * Order is not guaranteed but every unique ID appears exactly once.
 */
export function mergeIds(...idArrays: string[][]): string[] {
  return [...new Set(idArrays.flat())];
}
