export function mergeIds(...idArrays: string[][]): string[] {
  return [...new Set(idArrays.flat())];
}
