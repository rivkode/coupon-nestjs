import type { TxContext } from '@app/common';
import type { OutboxRecord } from './outbox-event';

/** Outbox 리포지토리 (원본 `OutboxEventJpaRepository`). */
export abstract class OutboxEventRepository {
  /**
   * 발급 트랜잭션 **안에서** INSERT 한다 (ADR-002). status 는 항상 PENDING 으로 시작.
   * 여기서 Kafka 로 보내지 않는다 — 발행은 `OutboxPoller` 가 트랜잭션 밖에서 한다.
   */
  abstract append(
    tx: TxContext,
    record: { aggregateId: string; eventType: string; payload: string },
  ): Promise<void>;

  /**
   * PENDING row 를 `created_at ASC` 로 batch 만큼 가져온다 (`idx_outbox_status_created`).
   * ⚠️ 트랜잭션을 받지 않는다 — poller 는 짧은 read 로만 조회한다 (원본 주석 참고).
   */
  abstract findPending(limit: number): Promise<OutboxRecord[]>;

  /**
   * 발행에 성공한 id 만 모아 한 번의 bulk update 로 PUBLISHED 처리한다.
   * 실패한 건은 PENDING 으로 남아 다음 주기에 재시도된다 (at-least-once).
   */
  abstract markPublished(ids: number[], publishedAt: Date): Promise<number>;
}
