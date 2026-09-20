import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { UserCouponStatus } from '../../domain/statuses';

/**
 * `user_coupon` (원본 `UserCouponJpaEntity`).
 *
 * ⚠️ BIGINT 컬럼은 mysql2 가 **string** 으로 돌려준다. 매퍼가 `Number()` 로 정규화한다
 *    (typeorm-patterns §6.1). 여기서 타입을 속이지 말 것.
 * ⚠️ `version` 에 `@VersionColumn` 을 쓰지 않는다 — TypeORM 은 UPDATE 에 `WHERE version` 가드를
 *    넣지 않아 낙관락이 동작하지 않는다 (ADR-N03). 평범한 컬럼으로 두고 조건부 UPDATE 로 다룬다.
 */
@Entity({ name: 'user_coupon' })
export class UserCouponOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'user_coupon_id' })
  userCouponId!: string;

  @Column({ type: 'varchar', length: 32, name: 'code' })
  code!: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId!: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'bigint', name: 'coupon_type_id' })
  couponTypeId!: string;

  // 스키마가 VARCHAR(20) 이다. type:'enum' 은 MySQL ENUM 을 만들어 원본과 달라진다 (ADR-N05).
  @Column({ type: 'varchar', length: 20, name: 'status' })
  status!: UserCouponStatus;

  @Column({ type: 'datetime', precision: 3, name: 'issued_at' })
  issuedAt!: Date;

  @Column({ type: 'datetime', precision: 3, name: 'used_at', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'bigint', name: 'version' })
  version!: string;

  // DB DEFAULT / ON UPDATE 가 채운다 — 앱에서 쓰지 않는다 (원본의 insertable=false, updatable=false).
  @Column({
    type: 'datetime',
    precision: 3,
    name: 'created_at',
    insert: false,
    update: false,
  })
  createdAt!: Date;

  @Column({
    type: 'datetime',
    precision: 3,
    name: 'updated_at',
    insert: false,
    update: false,
  })
  updatedAt!: Date;
}
