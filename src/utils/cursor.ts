// Cursor helpers for DynamoDB pagination.
// Encodes/decodes DynamoDB LastEvaluatedKey as a URL-safe base64url string.
// Centralised here so all services use identical encoding — mixing base64 and
// base64url between services caused silent decode failures on cross-service cursors.

export const encodeCursor = (key: Record<string, any>): string =>
  Buffer.from(JSON.stringify(key)).toString('base64url');

export const decodeCursor = (cursor?: string): Record<string, any> | undefined => {
  if (!cursor) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
  } catch {
    return undefined;
  }
};
