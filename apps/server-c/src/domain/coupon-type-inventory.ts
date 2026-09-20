/**
 * 재고 애그리거트 (ADR-003). **재고의 권위는 이 테이블 row 하나**다 —
 * Redis 의 SOLD_OUT 캐시는 비용 절감용이지 권위가 아니다.
 *
 * `decrement()` 는 반드시 **비관적 락(`SELECT ... FOR UPDATE`) 안에서** 호출해야 한다.
 * 락 없이 부르면 동시 차감이 겹쳐 재고가 음수로 내려간다.
 */
export class CouponTypeInventory {
  private constructor(
    readonly id: number,
    readonly eventId: number,
    readonly couponTypeId: number,
    readonly totalInventory: number,
    private _availableCount: number,
  ) {}

  static reconstitute(params: {
    id: number;
    eventId: number;
    couponTypeId: number;
    totalInventory: number;
    availableCount: number;
  }): CouponTypeInventory {
    return new CouponTypeInventory(
      params.id,
      params.eventId,
      params.couponTypeId,
      params.totalInventory,
      params.availableCount,
    );
  }

  get availableCount(): number {
    return this._availableCount;
  }

  /** 재고 차감. 0 이하면 false (매진). 호출 측이 비관적 락 안에서 호출해야 함. */
  decrement(): boolean {
    if (this._availableCount <= 0) {
      return false;
    }
    this._availableCount--;
    return true;
  }

  isDepleted(): boolean {
    return this._availableCount === 0;
  }
}
