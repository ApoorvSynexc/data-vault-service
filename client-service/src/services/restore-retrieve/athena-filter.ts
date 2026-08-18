/**
 * Thrown by athena-fetch's column-name validation (and mapped to a 400 by the
 * controller) when a caller-supplied identifier fails the strict column-name
 * pattern.
 */
export class FilterError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'FilterError';
  }
}
