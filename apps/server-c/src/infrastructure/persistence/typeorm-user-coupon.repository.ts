import type { TxContext } from '@app/common';
import { Injectable } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import {
  DuplicateUserCouponError,
  UK_USER_COUPON_USER_TYPE,
} from '../../domain/exception/duplicate-user-coupon.error';
import type { UserCoupon } from '../../domain/user-coupon';
import { UserCouponRepository } from '../../domain/user-coupon.repository';
import { UserCouponMapper } from './mappers';
import { UserCouponOrmEntity } from './user-coupon.orm-entity';

/** MySQL `ER_DUP_ENTRY`. 메시지 문자열 대신 errno 로 판단한다 (typeorm-patterns §6.4). */
const ER_DUP_ENTRY = 1062;

@Injectable()
export class TypeOrmUserCouponRepository extends UserCouponRepository {
  async existsByUserIdAndCouponTypeId(
    tx: TxContext,
    userId: number,
    couponTypeId: number,
  ): Promise<boolean> {
    const count = await em(tx).count(UserCouponOrmEntity, {
      where: { userId: String(userId), couponTypeId: String(couponTypeId) },
    });
    return count > 0;
  }

  async findByCode(tx: TxContext, code: string): Promise<UserCoupon | null> {
    const row = await em(tx).findOne(UserCouponOrmEntity, { where: { code } });
    return row ? UserCouponMapper.toDomain(row) : null;
  }

  async findByUserIdAndCouponTypeId(
    tx: TxContext,
    userId: number,
    couponTypeId: number,
  ): Promise<UserCoupon | null> {
    const row = await em(tx).findOne(UserCouponOrmEntity, {
      where: { userId: String(userId), couponTypeId: String(couponTypeId) },
    });
    return row ? UserCouponMapper.toDomain(row) : null;
  }

  async findAllByUserId(tx: TxContext, userId: number): Promise<UserCoupon[]> {
    const rows = await em(tx).find(UserCouponOrmEntity, {
      where: { userId: String(userId) },
      order: { issuedAt: 'DESC' },
    });
    return rows.map((row) => UserCouponMapper.toDomain(row));
  }

  /**
   * `save()` 가 아니라 `insert()` 를 쓴다 — save 는 id 유무를 보고 SELECT 를 한 번 더 돌린다.
   * 발급은 핫 경로라 왕복을 줄인다 (typeorm-patterns §6.5).
   */
  async insert(tx: TxContext, coupon: UserCoupon): Promise<void> {
    try {
      await em(tx).insert(
        UserCouponOrmEntity,
        UserCouponMapper.toInsertValues(coupon),
      );
    } catch (e) {
      // ⚠️ `(user_id, coupon_type_id)` 위반만 멱등 신호다. `code` 위반은 전혀 다른 사고이므로
      //    그대로 올려 드러낸다 (DuplicateUserCouponError 주석 참고).
      if (violatedConstraint(e) === UK_USER_COUPON_USER_TYPE) {
        throw new DuplicateUserCouponError(
          `user_coupon already exists: userId=${coupon.userId}, couponTypeId=${coupon.couponTypeId}`,
        );
      }
      throw e;
    }
  }

  /**
   * ADR-N03 — 낙관적 락을 **조건부 UPDATE** 로 구현한다.
   *
   * TypeORM 의 `@VersionColumn` 은 `version = version + 1` 을 SET 만 하고
   * `WHERE version = ?` 가드를 넣지 않아, `save()` 로는 동시 redeem 두 건이 모두 성공한다.
   * 여기서 직접 조건을 걸고 `affected` 로 승패를 판정한다.
   */
  async markUsed(
    tx: TxContext,
    id: number,
    expectedVersion: number,
    usedAt: Date,
  ): Promise<number> {
    const result = await em(tx)
      .createQueryBuilder()
      .update(UserCouponOrmEntity)
      .set({
        status: 'USED',
        usedAt,
        version: () => 'version + 1',
      })
      .where('user_coupon_id = :id AND version = :expectedVersion', {
        id: String(id),
        expectedVersion: String(expectedVersion),
      })
      .execute();

    return result.affected ?? 0;
  }
}

/** `TxContext` 는 도메인 측 불투명 타입이라 infrastructure 에서만 좁힌다 (ADR-N01). */
function em(tx: TxContext): EntityManager {
  return tx as EntityManager;
}

/**
 * UNIQUE 위반이면 **위반된 제약 이름**을, 아니면 null 을 돌려준다.
 *
 * mysql2 의 메시지 형식: `Duplicate entry 'X' for key 'user_coupon.uk_user_coupon_code'`
 * (MySQL 8.0.19+ 는 `테이블.제약` 형태라 테이블 접두사를 떼어낸다).
 * 메시지 파싱이 마음에 들지는 않지만, 드라이버가 제약 이름을 별도 필드로 주지 않는다.
 */
function violatedConstraint(e: unknown): string | null {
  if (!(e instanceof QueryFailedError)) return null;
  const driver = e.driverError as
    { errno?: number; sqlMessage?: string } | undefined;
  if (driver?.errno !== ER_DUP_ENTRY) return null;

  const match = /for key '(?:.*\.)?(.+?)'/.exec(driver.sqlMessage ?? '');
  return match?.[1] ?? null;
}
