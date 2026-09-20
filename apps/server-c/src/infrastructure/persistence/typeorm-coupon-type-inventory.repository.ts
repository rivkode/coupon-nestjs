import type { TxContext } from '@app/common';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { CouponTypeInventory } from '../../domain/coupon-type-inventory';
import { CouponTypeInventoryRepository } from '../../domain/coupon-type-inventory.repository';
import { CouponTypeInventoryOrmEntity } from './coupon-type-inventory.orm-entity';
import { CouponTypeInventoryMapper } from './mappers';

@Injectable()
export class TypeOrmCouponTypeInventoryRepository extends CouponTypeInventoryRepository {
  /**
   * ADR-003 — `SELECT ... FOR UPDATE`.
   *
   * ⚠️ 반드시 트랜잭션 EntityManager 에서 시작한 QueryBuilder 여야 한다.
   *    `dataSource.getRepository()` 로 만들면 다른 커넥션이라 락이 걸리지 않는다.
   *    `findOne({ lock })` 대신 QueryBuilder 를 표준으로 쓴다 (조인이 붙으면 MySQL 이 거부).
   */
  async findForUpdate(
    tx: TxContext,
    eventId: number,
    couponTypeId: number,
  ): Promise<CouponTypeInventory | null> {
    const row = await em(tx)
      .createQueryBuilder(CouponTypeInventoryOrmEntity, 'i')
      .setLock('pessimistic_write')
      .where('i.event_id = :eventId AND i.coupon_type_id = :couponTypeId', {
        eventId: String(eventId),
        couponTypeId: String(couponTypeId),
      })
      .getOne();

    return row ? CouponTypeInventoryMapper.toDomain(row) : null;
  }

  async findByEventIdAndCouponTypeId(
    tx: TxContext,
    eventId: number,
    couponTypeId: number,
  ): Promise<CouponTypeInventory | null> {
    const row = await em(tx).findOne(CouponTypeInventoryOrmEntity, {
      where: { eventId: String(eventId), couponTypeId: String(couponTypeId) },
    });
    return row ? CouponTypeInventoryMapper.toDomain(row) : null;
  }

  async updateAvailableCount(
    tx: TxContext,
    inventory: CouponTypeInventory,
  ): Promise<void> {
    await em(tx).update(
      CouponTypeInventoryOrmEntity,
      { couponTypeInventoryId: String(inventory.id) },
      { availableCount: inventory.availableCount },
    );
  }
}

function em(tx: TxContext): EntityManager {
  return tx as EntityManager;
}
