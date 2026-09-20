import type { TxContext } from '@app/common';
import type { Event } from './event';
import type { EventStatus } from './statuses';

/** 이벤트 리포지토리 (원본 `EventJpaRepository`). */
export abstract class EventRepository {
  abstract findById(tx: TxContext, eventId: number): Promise<Event | null>;

  /**
   * `EventCacheRefresher` 의 갱신 대상 목록.
   * `idx_event_status` 인덱스가 있어 적은 비용으로 스캔 가능하다.
   */
  abstract findByStatus(tx: TxContext, status: EventStatus): Promise<Event[]>;
}
