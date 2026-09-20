import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { EventStatus } from '../../domain/statuses';

/** `event` (원본 `EventJpaEntity`). */
@Entity({ name: 'event' })
export class EventOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'varchar', length: 200, name: 'name' })
  name!: string;

  @Column({ type: 'text', name: 'content', nullable: true })
  content!: string | null;

  @Column({ type: 'datetime', precision: 3, name: 'started_at' })
  startedAt!: Date;

  @Column({ type: 'datetime', precision: 3, name: 'ended_at' })
  endedAt!: Date;

  // V2 에서 추가된 컬럼. DEFAULT 'CREATED'.
  @Column({ type: 'varchar', length: 20, name: 'status' })
  status!: EventStatus;

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
