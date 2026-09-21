import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { IssueRequestStatus } from '../../domain/statuses';

/** `issue_request` (원본 `IssueRequestJpaEntity`). */
@Entity({ name: 'issue_request' })
export class IssueRequestOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'id' })
  id!: string;

  @Column({ type: 'varchar', length: 36, name: 'request_id' })
  requestId!: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId!: string;

  @Column({ type: 'bigint', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'bigint', name: 'coupon_type_id' })
  couponTypeId!: string;

  // 스키마가 VARCHAR(20) 이다. type:'enum' 은 MySQL ENUM 을 만들어 스키마가 달라진다.
  @Column({ type: 'varchar', length: 20, name: 'status' })
  status!: IssueRequestStatus;

  // DB DEFAULT 가 채운다 — 앱에서 쓰지 않는다.
  @Column({
    type: 'datetime',
    precision: 3,
    name: 'created_at',
    insert: false,
    update: false,
  })
  createdAt!: Date;
}
