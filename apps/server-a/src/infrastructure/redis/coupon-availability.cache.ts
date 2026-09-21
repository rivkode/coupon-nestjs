import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.module';
import { RedisKeys } from './redis-keys';

/**
 * 매진 negative cache 의 **읽기 측** (원본 `CouponAvailabilityCache`).
 * 쓰는 쪽은 server-c 다.
 *
 * 매진된 이벤트의 후속 요청을 **A 진입에서 차단**해 B 호출·Redis 적재·Kafka 왕복·
 * C 의 비관적 락을 전부 절약한다. 이 시나리오는 요청 대부분이 매진 이후에 도착하므로
 * 차단 위치를 가장 앞으로 두는 것이 핵심이다.
 *
 * Redis 장애 시 **false 로 fall-through** 한다 (안전한 degradation) —
 * 정상 흐름으로 진행하면 C 의 비관적 락 + UNIQUE 가 정합성을 보호한다.
 */
@Injectable()
export class CouponAvailabilityCache {
  private readonly logger = new Logger(CouponAvailabilityCache.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async isSoldOut(eventId: number, couponTypeId: number): Promise<boolean> {
    try {
      const exists = await this.redis.exists(
        RedisKeys.couponAvailable(eventId, couponTypeId),
      );
      return exists === 1;
    } catch (e) {
      this.logger.warn(
        `sold-out cache read failed (fall-through to B): eventId=${eventId}, couponTypeId=${couponTypeId} reason=${String(e)}`,
      );
      return false;
    }
  }
}
