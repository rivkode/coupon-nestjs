import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { EventView } from '../../application/views';
import { REDIS_CLIENT } from './redis.module';
import { RedisKeys } from './redis-keys';

/**
 * 이벤트 정보 Redis 캐시 — JSON 직렬화 + TTL (원본 `EventCacheStore`).
 *
 * Cache stampede 의 1 차 방어선은 `EventCacheRefresher` 의 Refresh-Ahead 로 TTL 만료 자체를
 * 회피하는 것이다. 본 클래스는 단순한 put/get 만 책임진다.
 *
 * 모든 실패를 삼킨다 — 캐시는 권위가 아니고 DB fallback 이 항상 존재한다.
 */
@Injectable()
export class EventCacheStore {
  private readonly logger = new Logger(EventCacheStore.name);
  private readonly ttlSeconds = Number(
    process.env.EVENT_CACHE_TTL_SECONDS ?? 300,
  );

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async put(event: EventView): Promise<void> {
    try {
      await this.redis.set(
        RedisKeys.event(event.eventId),
        JSON.stringify(event),
        'EX',
        this.ttlSeconds,
      );
    } catch (e) {
      // 캐시 미적용은 fallback 으로 DB 가 받아주므로 swallow.
      this.logger.warn(
        `failed to cache event: eventId=${event.eventId} reason=${String(e)}`,
      );
    }
  }

  async get(eventId: number): Promise<EventView | null> {
    let json: string | null;
    try {
      json = await this.redis.get(RedisKeys.event(eventId));
    } catch (e) {
      // Redis 일시 장애 — DB fallback 가능하도록 빈 결과.
      this.logger.warn(
        `redis get failed: eventId=${eventId} reason=${String(e)}`,
      );
      return null;
    }
    if (json === null) {
      return null;
    }
    try {
      return JSON.parse(json) as EventView;
    } catch (e) {
      this.logger.warn(
        `malformed event cache entry — falling back to DB: eventId=${eventId} reason=${String(e)}`,
      );
      return null;
    }
  }
}
