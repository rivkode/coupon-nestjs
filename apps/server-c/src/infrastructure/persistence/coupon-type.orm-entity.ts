import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `coupon_type` (원본 `CouponTypeJpaEntity`).
 *
 * 프로덕션 코드에서 직접 조회하는 경로는 없다 (원본 `CouponTypeJpaRepository` 도 메서드가 없다).
 * `coupon_type_inventory` / `user_coupon` 의 FK 대상이라 스키마 정합과 테스트 픽스처용으로 둔다.
 */
@Entity({ name: 'coupon_type' })
export class CouponTypeOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'coupon_type_id' })
  couponTypeId!: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'varchar', length: 200, name: 'name' })
  name!: string;

  @Column({ type: 'int', name: 'discount_rate' })
  discountRate!: number;

  @Column({
    type: 'datetime',
    precision: 3,
    name: 'created_at',
    insert: false,
    update: false,
  })
  createdAt!: Date;
}
