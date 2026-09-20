import type { UserCouponStatus } from './statuses';

/**
 * 발급 결과 애그리거트 (원본 `UserCouponJpaEntity` 의 도메인 규칙 부분).
 *
 * `(user_id, coupon_type_id)` UNIQUE 가 1 인 1 장 + Kafka 멱등성을 동시에 보장한다 (ADR-004).
 * `code` 는 발급된 쿠폰의 외부 식별자로 redeem 에 쓰인다.
 *
 * ⚠️ ID 는 모두 `number` 다 — ORM 경계(매퍼)에서 정규화한다 (typeorm-patterns §6.1).
 */
export class UserCoupon {
  private constructor(
    readonly id: number | null,
    readonly code: string,
    readonly userId: number,
    readonly eventId: number,
    readonly couponTypeId: number,
    readonly status: UserCouponStatus,
    readonly issuedAt: Date,
    readonly usedAt: Date | null,
    readonly version: number,
  ) {}

  /** 새 발급 결과. SOLD_OUT / FAILED 도 row 를 남겨 사용자 폴링 응답이 가능하게 한다. */
  static issue(params: {
    code: string;
    userId: number;
    eventId: number;
    couponTypeId: number;
    status: UserCouponStatus;
    issuedAt: Date;
  }): UserCoupon {
    return new UserCoupon(
      null,
      params.code,
      params.userId,
      params.eventId,
      params.couponTypeId,
      params.status,
      params.issuedAt,
      null,
      0,
    );
  }

  /** DB 에서 복원 (매퍼 전용). */
  static reconstitute(params: {
    id: number;
    code: string;
    userId: number;
    eventId: number;
    couponTypeId: number;
    status: UserCouponStatus;
    issuedAt: Date;
    usedAt: Date | null;
    version: number;
  }): UserCoupon {
    return new UserCoupon(
      params.id,
      params.code,
      params.userId,
      params.eventId,
      params.couponTypeId,
      params.status,
      params.issuedAt,
      params.usedAt,
      params.version,
    );
  }

  /** 이 사용자의 쿠폰인가. 아니면 호출 측이 **404 로 마스킹**한다 (존재 여부를 흘리지 않는다). */
  isOwnedBy(userId: number): boolean {
    return this.userId === userId;
  }

  /** 이미 사용됐는가 — 같은 user 의 재호출은 멱등 200 으로 처리한다. */
  isRedeemed(): boolean {
    return this.usedAt !== null;
  }

  /**
   * redeem 가능 여부 (원본 `markUsed` 의 가드 부분).
   * SUCCESS 가 아니면(=SOLD_OUT/FAILED/USED) 사용할 수 없다.
   *
   * ⚠️ 실제 상태 전이는 도메인 객체가 하지 않는다. ADR-N03 에 따라 리포지토리의
   *    조건부 UPDATE (`WHERE version = ?`) 가 수행하고, `affected === 0` 이면 경합이다.
   */
  isRedeemable(): boolean {
    return this.status === 'SUCCESS' && this.usedAt === null;
  }
}
