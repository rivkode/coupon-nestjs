import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.module';
import { RedisKeys } from './redis-keys';

/**
 * ADR-011 SOLD_OUT negative cache 의 **쓰기 측** (원본 `CouponAvailabilityCache`).
 * 읽는 쪽은 server-a 다 — 키 이름이 곧 두 서버 사이의 계약이다.
 *
 * 키 존재만으로 매진을 표현한다. 값은 의미 없음("1"). TTL 24h (b 의 pending hash TTL 와 동일).
 *
 * 매번 SET 으로 TTL 이 갱신되는 것은 **의도된 동작**이다. 매진 상태에서 a 가 단락하므로 호출 빈도
 * 자체가 줄고, restock 후 들어온 메시지는 fresh read 가 0 이 아니라 SET 을 호출하지 않는다 →
 * stale 키는 24h 안에 자연 만료. NX 로 최초 1회만 적재하면 TTL 만료 후 재적재가 안 돼 오히려 부정확하다.
 *
 * 쓰기 실패는 catch + log — 재고는 여전히 0 이므로 다음 SOLD_OUT 처리가 자연 회복한다.
 */
@Injectable()
export class CouponAvailabilityCache {
  private readonly logger = new Logger(CouponAvailabilityCache.name);
  private static readonly SENTINEL_VALUE = '1';
  private readonly ttlSeconds = Number(
    process.env.COUPON_AVAILABLE_TTL_SECONDS ?? 86400,
  );

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async markSoldOut(eventId: number, couponTypeId: number): Promise<void> {
    try {
      await this.redis.set(
        RedisKeys.couponAvailable(eventId, couponTypeId),
        CouponAvailabilityCache.SENTINEL_VALUE,
        'EX',
        this.ttlSeconds,
      );
      this.logger.log(
        `sold-out cache set: eventId=${eventId}, couponTypeId=${couponTypeId}`,
      );
    } catch (e) {
      // 권위는 MySQL — 캐시 실패는 다음 SOLD_OUT 호출이 자연 회복.
      this.logger.warn(
        `failed to set sold-out cache: eventId=${eventId}, couponTypeId=${couponTypeId} reason=${String(e)}`,
      );
    }
  }
}
