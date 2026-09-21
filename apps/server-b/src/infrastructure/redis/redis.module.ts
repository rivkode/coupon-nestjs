import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * ioredis 클라이언트 프로바이더 (원본 `RedisConfig` 의 `StringRedisTemplate` 자리).
 *
 * 원본 server-b yml 의 값을 그대로 옮긴다: `timeout: 1000ms`, `connect-timeout: 1000ms`.
 * Lettuce 풀 설정(server-b 는 max-active 24 등)은 ioredis 가 단일 연결 + 파이프라이닝 모델이라
 * 1:1 대응물이 없다 — **미이관**이며 사이징 단계에서 재검토한다.
 *
 * 종료 시 연결 정리는 `main.ts` 의 `app.enableShutdownHooks()` 가 있어야 동작한다.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis =>
        new Redis({
          host: process.env.REDIS_HOST ?? 'localhost',
          port: Number(process.env.REDIS_PORT ?? 6379),
          connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 1000),
          commandTimeout: Number(process.env.REDIS_TIMEOUT_MS ?? 1000),
          // ⚠️ b 에는 DB fallback 이 없다 (ADR-006 — 이 Redis 가 유일한 저장소).
          // 그래도 재시도로 이벤트 루프를 붙잡으면 접수 응답 latency 가 무너지므로 빨리 실패시키고,
          // 회복은 ADR-008 스케줄러에 맡긴다 (publish 실패와 같은 취급).
          maxRetriesPerRequest: 1,
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
