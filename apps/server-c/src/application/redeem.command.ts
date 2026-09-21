import { InvalidArgumentError } from '@app/common';

/**
 * Redeem API 입력 (원본 `RedeemCommand` record).
 * ADR-004 — Idempotency-Key 헤더는 쓰지 않는다.
 *
 * ⚠️ 검증 실패는 `InvalidArgumentError` — 원본의 `IllegalArgumentException` 에 대응해
 *    **400 INVALID_ARGUMENT + 메시지 그대로 노출**이 된다 (api-contract §4).
 *    null 검사만 원본이 `Objects.requireNonNull` 이라 500 으로 남는다.
 */
export class RedeemCommand {
  constructor(
    readonly code: string,
    readonly userId: number,
  ) {
    if (code == null) {
      throw new Error('code');
    }
    if (code.trim() === '') {
      throw new InvalidArgumentError('code must not be blank');
    }
    if (userId <= 0) {
      throw new InvalidArgumentError(
        `userId must be positive but was ${userId}`,
      );
    }
  }
}
