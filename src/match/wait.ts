export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 轮询直到 predicate 为 true；超时抛错 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
  intervalMs = 100,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await sleep(intervalMs);
  }
}
