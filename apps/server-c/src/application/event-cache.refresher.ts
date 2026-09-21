import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { EventRepository } from '../domain/event.repository';
import { EventCacheStore } from '../infrastructure/redis/event-cache.store';
import { toEventView } from './views';

const REFRESH_INTERVAL_MS = Number(process.env.EVENT_CACHE_REFRESH_MS ?? 60000);

/**
 * Refresh-Ahead — IN_PROGRESS 이벤트를 주기적으로 DB 에서 읽어 Redis 에 다시 적재
 * (원본 `EventCacheRefresher`).
 *
 * 핵심: refresh-interval(60s) < ttl(300s) 이라 캐시는 항상 "방금 갱신된 상태" 를 유지한다
 * → TTL 만료 시점 자체가 오지 않음 → stampede 위험 원천 차단.
 *
 * 대상 제한: `status = IN_PROGRESS` 만 갱신한다. 생성/종료/취소 상태는 빈번 조회가 없으므로
 * 자연 만료를 허용한다.
 *
 * 트랜잭션을 걸지 않는다 — DB 조회는 짧은 read 로 끝나고 결과는 이미 view 로 떠 있다.
 * 이후 Redis 쓰기 루프를 트랜잭션 안에 두면 커넥션만 그 시간만큼 잡고 있게 된다 (원본 §10).
 */
@Injectable()
export class EventCacheRefresher implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventCacheRefresher.name);
  private running = false;

  constructor(
    private readonly eventRepository: EventRepository,
    private readonly cacheStore: EventCacheStore,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Spring `fixedDelay` 는 기동 직후 1회 실행한다 — `@Interval` 은 안 돌아서 맞춰준다.
   *
   * ⚠️ **await 하지 않는다.** Nest 는 bootstrap 훅을 await 한 뒤에야 포트를 연다.
   *    첫 cycle 이 느리면(예: stale 50건 × c 호출 1.5s) 그만큼 HTTP 포트가 안 열려
   *    health probe 가 실패한다. Spring 은 별도 스케줄러 스레드라 기동을 막지 않는다.
   */
  onApplicationBootstrap(): void {
    void this.refreshActiveEvents();
  }

  @Interval(REFRESH_INTERVAL_MS)
  async refreshActiveEvents(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const events = await this.eventRepository.findByStatus(
        this.dataSource.manager,
        'IN_PROGRESS',
      );

      for (const event of events) {
        await this.cacheStore.put(toEventView(event));
      }

      if (events.length > 0) {
        this.logger.debug(
          `refreshed ${events.length} IN_PROGRESS event(s) in cache`,
        );
      }
    } catch (e) {
      this.logger.error(`event cache refresh failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
