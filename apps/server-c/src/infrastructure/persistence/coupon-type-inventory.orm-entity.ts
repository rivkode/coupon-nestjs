import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** `coupon_type_inventory` (원본 `CouponTypeInventoryJpaEntity`). 재고의 권위 (ADR-003). */
@Entity({ name: 'coupon_type_inventory' })
export class CouponTypeInventoryOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'coupon_type_inventory_id' })
  couponTypeInventoryId!: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'bigint', name: 'coupon_type_id' })
  couponTypeId!: string;

  @Column({ type: 'int', name: 'total_inventory' })
  totalInventory!: number;

  @Column({ type: 'int', name: 'available_count' })
  availableCount!: number;

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
