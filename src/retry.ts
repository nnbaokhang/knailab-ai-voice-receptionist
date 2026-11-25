export type FetchLike = typeof fetch;

export async function fetchWithRetry(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  options: { attempts: number; timeoutMs: number; baseDelayMs?: number } ,
): Promise<Response> {
  const base = options.baseDelayMs ?? 150;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (![408, 425, 429].includes(response.status) && response.status < 500) return response;
      if (attempt === options.attempts) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : base * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === options.attempts) break;
      await new Promise((resolve) => setTimeout(resolve, base * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed after retries");
}
