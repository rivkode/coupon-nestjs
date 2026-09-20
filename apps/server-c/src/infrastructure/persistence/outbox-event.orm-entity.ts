import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { OutboxEventStatus } from '../../domain/statuses';

/**
 * `outbox_event` (원본 `OutboxEventJpaEntity`).
 * `status` 는 "아직 Kafka 로 안 보냈는가" 라는 메타 상태다 — 발급 결과는 payload 안에 있다.
 */
@Entity({ name: 'outbox_event' })
export class OutboxEventOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'outbox_event_id' })
  outboxEventId!: string;

  @Column({ type: 'varchar', length: 64, name: 'aggregate_id' })
  aggregateId!: string;

  @Column({ type: 'varchar', length: 50, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'text', name: 'payload' })
  payload!: string;

  @Column({ type: 'varchar', length: 20, name: 'status' })
  status!: OutboxEventStatus;

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
    name: 'published_at',
    nullable: true,
  })
  publishedAt!: Date | null;
}
