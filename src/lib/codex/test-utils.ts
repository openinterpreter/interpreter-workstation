export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  { timeoutMs = 25_000, intervalMs = 500 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await fn();
    if (predicate(result)) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
