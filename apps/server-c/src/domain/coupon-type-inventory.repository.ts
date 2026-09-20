import type { TxContext } from '@app/common';
import type { CouponTypeInventory } from './coupon-type-inventory';

/** 재고 리포지토리 (원본 `CouponTypeInventoryJpaRepository`). */
export abstract class CouponTypeInventoryRepository {
  /**
   * ADR-003 — `SELECT ... FOR UPDATE` 로 행 락을 잡고 조회한다.
   * **반드시 트랜잭션 `TxContext` 로 호출**해야 한다. 아니면 락이 걸리지 않는다.
   */
  abstract findForUpdate(
    tx: TxContext,
    eventId: number,
    couponTypeId: number,
  ): Promise<CouponTypeInventory | null>;

  /** 락 없는 일반 조회. ADR-011 의 커밋 후 fresh read 에 쓴다. */
  abstract findByEventIdAndCouponTypeId(
    tx: TxContext,
    eventId: number,
    couponTypeId: number,
  ): Promise<CouponTypeInventory | null>;

  /** 차감된 `available_count` 를 반영한다. 락을 잡은 같은 트랜잭션에서 호출할 것. */
  abstract updateAvailableCount(
    tx: TxContext,
    inventory: CouponTypeInventory,
  ): Promise<void>;
}
