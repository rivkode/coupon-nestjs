import { CouponTypeInventory } from '../../domain/coupon-type-inventory';
import { Event } from '../../domain/event';
import { UserCoupon } from '../../domain/user-coupon';
import type { CouponTypeInventoryOrmEntity } from './coupon-type-inventory.orm-entity';
import type { EventOrmEntity } from './event.orm-entity';
import type { UserCouponOrmEntity } from './user-coupon.orm-entity';

/**
 * ORM 엔티티 ↔ 도메인 모델 변환. **ID 정규화가 일어나는 유일한 지점**이다.
 *
 * mysql2 는 BIGINT 를 string 으로 돌려준다. 도메인·wire 는 number 로 통일하므로
 * 여기서 `Number()` 를 태운다 (typeorm-patterns §6.1). 이 경계를 건너뛰고 ORM 엔티티의
 * id 를 도메인 값과 직접 비교하면 `"123" !== 123` 으로 조용히 깨진다.
 */

export const UserCouponMapper = {
  toDomain(row: UserCouponOrmEntity): UserCoupon {
    return UserCoupon.reconstitute({
      id: Number(row.userCouponId),
      code: row.code,
      userId: Number(row.userId),
      eventId: Number(row.eventId),
      couponTypeId: Number(row.couponTypeId),
      status: row.status,
      issuedAt: row.issuedAt,
      usedAt: row.usedAt,
      version: Number(row.version),
    });
  },

  /** INSERT 용 평문 객체. id / created_at / updated_at 은 DB 가 채운다. */
  toInsertValues(coupon: UserCoupon): Partial<UserCouponOrmEntity> {
    return {
      code: coupon.code,
      userId: String(coupon.userId),
      eventId: String(coupon.eventId),
      couponTypeId: String(coupon.couponTypeId),
      status: coupon.status,
      issuedAt: coupon.issuedAt,
      usedAt: coupon.usedAt,
      version: String(coupon.version),
    };
  },
} as const;

export const CouponTypeInventoryMapper = {
  toDomain(row: CouponTypeInventoryOrmEntity): CouponTypeInventory {
    return CouponTypeInventory.reconstitute({
      id: Number(row.couponTypeInventoryId),
      eventId: Number(row.eventId),
      couponTypeId: Number(row.couponTypeId),
      totalInventory: row.totalInventory,
      availableCount: row.availableCount,
    });
  },
} as const;

export const EventMapper = {
  toDomain(row: EventOrmEntity): Event {
    return Event.reconstitute({
      id: Number(row.eventId),
      name: row.name,
      content: row.content,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      status: row.status,
    });
  },
} as const;
