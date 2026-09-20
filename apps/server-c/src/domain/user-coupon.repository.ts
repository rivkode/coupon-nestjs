import type { TxContext } from '@app/common';
import type { UserCoupon } from './user-coupon';

/**
 * 발급 결과 리포지토리 (원본 `UserCouponJpaRepository`).
 *
 * 인터페이스가 아니라 **abstract class** 인 이유: TS interface 는 런타임에 사라져 DI 토큰이 될 수 없다
 * (nest-ddd-layering §2). 구현은 `infrastructure/persistence` 에서 `useClass` 로 바인딩한다.
 */
export abstract class UserCouponRepository {
  /** 발급 트랜잭션의 빠른 단락용. 멱등성의 권위는 `(user_id, coupon_type_id)` UNIQUE 다 (ADR-004). */
  abstract existsByUserIdAndCouponTypeId(
    tx: TxContext,
    userId: number,
    couponTypeId: number,
  ): Promise<boolean>;

  abstract findByCode(tx: TxContext, code: string): Promise<UserCoupon | null>;

  abstract findByUserIdAndCouponTypeId(
    tx: TxContext,
    userId: number,
    couponTypeId: number,
  ): Promise<UserCoupon | null>;

  /** `issued_at DESC` — 원본 `findAllByUserIdOrderByIssuedAtDesc`. 페이지네이션 없음. */
  abstract findAllByUserId(
    tx: TxContext,
    userId: number,
  ): Promise<UserCoupon[]>;

  /**
   * INSERT. `(user_id, coupon_type_id)` 또는 `code` UNIQUE 위반이면 **`DuplicateUserCouponError`** 를 던진다
   * (호출 측이 멱등 처리할 수 있도록 드라이버 예외를 도메인 예외로 바꿔서 올린다).
   */
  abstract insert(tx: TxContext, coupon: UserCoupon): Promise<void>;

  /**
   * redeem 의 조건부 UPDATE (ADR-N03).
   *
   * `SET status='USED', used_at=?, version=version+1 WHERE user_coupon_id=? AND version=?`
   * 를 실행하고 **변경된 행 수**를 돌려준다. 0 이면 그 사이 다른 요청이 선점한 것(낙관락 충돌).
   *
   * ⚠️ TypeORM 의 `@VersionColumn` + `save()` 는 `WHERE version` 가드를 넣지 않아
   *    동시 redeem 이 둘 다 성공한다. 반드시 이 경로로만 전이할 것.
   */
  abstract markUsed(
    tx: TxContext,
    id: number,
    expectedVersion: number,
    usedAt: Date,
  ): Promise<number>;
}
