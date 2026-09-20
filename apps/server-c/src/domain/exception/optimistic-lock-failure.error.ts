/**
 * Spring 의 `OptimisticLockingFailureException` 대응 → 409 RACE_RETRY.
 *
 * ⚠️ TypeORM 은 이 예외를 스스로 던지지 않는다 (ADR-N03).
 * 조건부 UPDATE 의 `affected === 0` 을 확인한 애플리케이션 코드가 직접 던진다.
 */
export class OptimisticLockFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticLockFailureError';
  }
}
