/**
 * Java `Future.get(timeout, unit)` 에 해당하는 **호출자 대기 상한**.
 *
 * ⚠️ kafkajs 의 `producer.send({ timeout })` 은 이것과 다르다 — 그 값은 **브로커의 ack 대기값**
 *    (Produce 요청에 실려 나간다) 이고, 로컬 재시도(`retry.retries`)나 미연결 상태의
 *    `connect()` 대기는 전혀 끊지 못한다. 그래서 원본 yml 이 명시한
 *    `scheduler-send-timeout-ms: 500` 같은 **cycle 보호 목적**의 timeout 은
 *    이 래퍼로 따로 걸어야 한다 (ADR-008).
 *
 * 타임아웃이 나도 내부 작업이 취소되지는 않는다 (Java 의 `Future.get` 도 마찬가지다).
 * 호출자를 풀어주는 것이 목적이다.
 */
export async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  // 레이스에서 진 쪽이 나중에 reject 해도 unhandled rejection 이 되지 않도록 먼저 붙여 둔다.
  void task.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
