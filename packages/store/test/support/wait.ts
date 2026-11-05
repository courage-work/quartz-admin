export interface WaitOptions {
  /** 기본 30초 */
  timeoutMs?: number;
  /** 기본 250ms */
  intervalMs?: number;
  /** 시간 초과 시 오류 메시지 */
  message?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `probe`가 falsy가 아닌 값을 돌려줄 때까지 반복한다. 마지막으로 던진 오류는 시간 초과 메시지에 붙인다.
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  options: WaitOptions = {},
): Promise<T> {
  const { timeoutMs = 30_000, intervalMs = 250, message = '대기 조건' } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`${message}: ${timeoutMs}ms 안에 만족하지 못했습니다${cause}`, {
        cause: lastError,
      });
    }
    await sleep(intervalMs);
  }
}
