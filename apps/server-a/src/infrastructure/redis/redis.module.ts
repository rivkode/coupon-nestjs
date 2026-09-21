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
 * 원본 server-a yml 의 값을 그대로 옮긴다: **`timeout: 500ms`, `connect-timeout: 500ms`**.
 * Lettuce 풀 설정(server-a 는 max-active 16 등)은 ioredis 가 단일 연결 + 파이프라이닝 모델이라
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
          connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 500),
          commandTimeout: Number(process.env.REDIS_TIMEOUT_MS ?? 500),
          // a 의 Redis 는 매진 단락 조회 전용이다. 진입 핫 경로라 timeout 이 b/c(1000ms)보다 짧고(500ms),
          // 실패하면 곧바로 정상 흐름으로 fall-through 한다 (캐시는 권위가 아니다).
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
