import type { PendingIssue } from './pending-issue';
import type { IssuePendingStatus } from './statuses';

/**
 * 신청 상태 저장소 (원본 `RedisIssueRequestStore`).
 *
 * server-b 는 **MySQL 이 없다** (ADR-006 — Redis only). 그래서 이 포트가 b 의 유일한 영속 경계다.
 * 트랜잭션 개념이 없으므로 `TxContext` 를 받지 않는다.
 */
export abstract class PendingIssueStore {
  /**
   * 동일 `(userId, couponTypeId)` 신청이 이미 있으면 `false`, 없으면 적재 후 `true`.
   *
   * 멱등성의 **권위는 server-c 의 UNIQUE** 다 (ADR-004). 여기는 비용 절감용 first-line guard 라
   * single-client race 가 나도 무해하다.
   */
  abstract savePendingIfAbsent(params: {
    requestId: string;
    userId: number;
    eventId: number;
    couponTypeId: number;
    createdAt: Date;
  }): Promise<boolean>;

  /**
   * ADR-008 재발행 기록. `publishAttempts` 를 증가시키고 `lastPublishedAt` 을
   * hash 와 ZSET score 양쪽에 갱신해 다음 cycle 까지 cutoff 만큼 grace 를 준다.
   * 상태는 PENDING 을 유지한다 (스케줄러가 다음 cycle 에 다시 잡을 수 있어야 한다).
   *
   * @returns 증가된 publishAttempts
   */
  abstract recordRepublish(
    userId: number,
    couponTypeId: number,
    publishedAt: Date,
  ): Promise<number>;

  /** 결과 반영 — Kafka result consumer 또는 스케줄러가 호출. 종료 상태는 ZSET 에서 제거한다. */
  abstract markResult(
    userId: number,
    couponTypeId: number,
    status: IssuePendingStatus,
    code: string | null,
  ): Promise<void>;

  /** cutoff(epoch ms) 이전 score 를 가진 PENDING 신청을 batch 만큼 가져온다 (ADR-008). */
  abstract findPendingOlderThan(
    cutoffEpochMs: number,
    batchSize: number,
  ): Promise<PendingIssue[]>;
}
