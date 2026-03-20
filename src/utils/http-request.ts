type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface HttpRequestOptions<TBody = any> {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: TBody;
  query?: Record<string, string | number | boolean>;
}

export async function httpRequest<TResponse = any, TBody = any>(
  options: HttpRequestOptions<TBody>
): Promise<TResponse> {
  const { url, method = 'GET', headers = {}, body, query } = options;

  // Build query string
  let finalUrl = url;
  if (query) {
    const queryString = new URLSearchParams(
      Object.entries(query).reduce((acc, [key, value]) => {
        acc[key] = String(value);
        return acc;
      }, {} as Record<string, string>)
    ).toString();

    finalUrl += `?${queryString}`;
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body && method !== 'GET') {
    fetchOptions.body = body as any;
  }

  const response = await fetch(finalUrl, fetchOptions);

  if (!response.ok) {
    console.log(response);
    
    const errorText = await response.text();
    throw new Error(`HTTP Error ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<TResponse>;
}