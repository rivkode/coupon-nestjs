/**
 * **`(user_id, coupon_type_id)` UNIQUE 위반** — 즉 "이 사용자는 이미 이 쿠폰을 받았다" (ADR-004).
 *
 * 원본은 Spring 의 `DataIntegrityViolationException` 을 잡아 멱등 early-return 했다.
 * TypeORM 의 `QueryFailedError` 를 애플리케이션까지 끌고 가면 계층이 새므로
 * 리포지토리 구현이 이 도메인 예외로 바꿔서 올린다.
 *
 * ⚠️ **`code` UNIQUE(`uk_user_coupon_code`) 위반은 여기에 포함되지 않는다.**
 *    원본은 두 제약을 구분하지 않고 `DataIntegrityViolationException` 하나로 잡는데,
 *    그러면 쿠폰 코드가 충돌했을 때도 "이미 발급됨" 으로 오인해 조용히 삼키게 된다.
 *    멱등성의 의미는 (user, couponType) 에만 있으므로 그쪽만 이 예외로 승격하고,
 *    코드 충돌은 원래 예외 그대로 올려 드러낸다.
 */
export class DuplicateUserCouponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateUserCouponError';
  }
}

/** `(user_id, coupon_type_id)` UNIQUE 제약 이름 — 스키마 그대로 (api-contract §7). */
export const UK_USER_COUPON_USER_TYPE = 'uk_user_coupon_user_type';
