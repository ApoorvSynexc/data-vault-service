type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const DEFAULT_TIMEOUT_MS = 30_000;

interface HttpRequestOptions<TBody = any> {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: TBody;
  query?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}

export async function httpRequest<TResponse = any, TBody = any>(
  options: HttpRequestOptions<TBody>
): Promise<TResponse> {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    query,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Build query string
  let finalUrl = url;
  if (query) {
    const queryString = new URLSearchParams(
      Object.entries(query).reduce(
        (acc, [key, value]) => {
          acc[key] = String(value);
          return acc;
        },
        {} as Record<string, string>
      )
    ).toString();

    finalUrl += `?${queryString}`;
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    signal: controller.signal,
  };

  if (body && method !== 'GET') {
    fetchOptions.body = body as any;
  }

  try {
    const response = await fetch(finalUrl, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`HTTP Error ${response.status}: ${errorText}`);
      // Structured access for callers that want to unwrap the raw response
      // (e.g. a JSON body's own `.message`) instead of parsing it back out
      // of this Error's formatted message string.
      (err as any).status = response.status;
      (err as any).body = errorText;
      throw err;
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : null) as TResponse;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      const err = new Error(`HTTP request timed out after ${timeoutMs}ms: ${url}`);
      (err as any).cause = error;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
