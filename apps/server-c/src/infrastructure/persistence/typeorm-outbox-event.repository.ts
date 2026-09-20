import type { TxContext } from '@app/common';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type { OutboxRecord } from '../../domain/outbox-event';
import { OutboxEventRepository } from '../../domain/outbox-event.repository';
import { OutboxEventOrmEntity } from './outbox-event.orm-entity';

@Injectable()
export class TypeOrmOutboxEventRepository extends OutboxEventRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  /** 발급 트랜잭션 안에서 INSERT (ADR-002). */
  async append(
    tx: TxContext,
    record: { aggregateId: string; eventType: string; payload: string },
  ): Promise<void> {
    await em(tx).insert(OutboxEventOrmEntity, {
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      status: 'PENDING',
    });
  }

  /**
   * poller 전용 — 짧은 read 하나로 끝난다. 트랜잭션을 받지 않는 이유는
   * 발행 왕복을 DB 트랜잭션 밖으로 빼는 것이 Outbox 패턴의 목적 자체이기 때문이다
   * (원본 `OutboxPoller` 주석 참고).
   */
  async findPending(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.dataSource.manager.find(OutboxEventOrmEntity, {
      where: { status: 'PENDING' },
      order: { createdAt: 'ASC' },
      take: limit,
    });

    return rows.map((row) => ({
      id: Number(row.outboxEventId),
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
    }));
  }

  /** 성공한 id 만 모아 한 문장으로 갱신한다. */
  async markPublished(ids: number[], publishedAt: Date): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await this.dataSource.manager.update(
      OutboxEventOrmEntity,
      { outboxEventId: In(ids.map((id) => String(id))) },
      { status: 'PUBLISHED', publishedAt },
    );
    return result.affected ?? 0;
  }
}

function em(tx: TxContext): EntityManager {
  return tx as EntityManager;
}
