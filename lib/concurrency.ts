// Races a promise against a fixed deadline, returning `fallback` if the
// deadline wins. Unlike an AbortSignal.timeout on an individual fetch, this
// bounds the *whole* call — including any caching/D1 work wrapped around
// it — so a request-path caller can guarantee a response within a fixed
// budget regardless of how slow (or how many retries deep) the underlying
// work turns out to be. The original promise is left to settle on its own;
// this only stops waiting on it.
export async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
