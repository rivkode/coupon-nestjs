import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventRepository } from '../domain/event.repository';
import { EventNotFoundError } from '../domain/exception/event-not-found.error';
import { EventCacheStore } from '../infrastructure/redis/event-cache.store';
import { toEventView, type EventView } from './views';

/**
 * 이벤트 조회 — Cache-Aside (원본 `EventQueryService`).
 *
 * Stampede 방어:
 *  - 1 차 (주력): `EventCacheRefresher` 의 Refresh-Ahead 로 TTL 만료 자체를 회피
 *  - 2 차 (fallback): cache miss → DB 조회 → put. 신규 IN_PROGRESS 전환 직후 1 tick 정도의
 *    짧은 윈도우에서만 DB 가 받는다
 *
 * 트랜잭션을 열지 않는다. 캐시 히트 경로는 DB 를 아예 쓰지 않고, 미스 경로도 단건 조회 하나뿐이다.
 * 트랜잭션을 열면 Redis 조회/쓰기가 DB 트랜잭션 경계 안에 들어간다 (원본 §10 안티패턴).
 */
@Injectable()
export class EventQueryService {
  constructor(
    private readonly cacheStore: EventCacheStore,
    private readonly eventRepository: EventRepository,
    private readonly dataSource: DataSource,
  ) {}

  async findById(eventId: number): Promise<EventView> {
    const cached = await this.cacheStore.get(eventId);
    if (cached !== null) {
      return cached;
    }

    const event = await this.eventRepository.findById(
      this.dataSource.manager,
      eventId,
    );
    if (event === null) {
      throw new EventNotFoundError(`event not found: ${eventId}`);
    }

    const view = toEventView(event);
    await this.cacheStore.put(view);
    return view;
  }
}
