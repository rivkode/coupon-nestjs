import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxEventRepository } from '../domain/outbox-event.repository';
import { IssueResultPublisher } from '../infrastructure/kafka/issue-result.publisher';

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500);

/**
 * `outbox_event` → Kafka publish (ADR-002). 원본 `OutboxPoller`.
 *
 * **트랜잭션을 걸지 않는다.** 걸면 batch 크기만큼의 Kafka publish 왕복이 하나의 DB 트랜잭션 안에
 * 들어가, 1 vCPU MySQL-C 의 커넥션을 발행 시간 내내 점유한다. 같은 DB 에서
 * `CouponIssueProcessor` 가 재고 행에 비관적 락을 잡고 있으므로 그대로 경합이 된다.
 * Outbox 패턴의 목적 자체가 발행을 트랜잭션 밖으로 빼는 것이다 (원본 §10).
 *
 * 대신 세 단계로 나눈다:
 *  1. 조회 — 리포지토리의 짧은 read
 *  2. 발행 — 트랜잭션 밖
 *  3. 상태 갱신 — 성공한 id 만 모아 한 번의 bulk update
 *
 * at-least-once 보장. 상태 갱신 전에 죽으면 같은 결과가 다시 발행되지만,
 * server-b 의 Redis 갱신이 멱등이라 안전하다.
 */
@Injectable()
export class OutboxPoller implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxPoller.name);
  private readonly batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 50);

  /** 이전 주기가 안 끝났는데 다음 주기가 겹쳐 도는 것을 막는다 (Node 는 단일 이벤트 루프 — ADR-N04). */
  private running = false;

  constructor(
    private readonly repository: OutboxEventRepository,
    private readonly publisher: IssueResultPublisher,
  ) {}

  /**
   * Spring `fixedDelay` 는 기동 직후 1회 실행한다 — `@Interval` 은 안 돌아서 맞춰준다.
   *
   * ⚠️ **await 하지 않는다.** Nest 는 bootstrap 훅을 await 한 뒤에야 포트를 연다.
   *    첫 cycle 이 느리면(예: stale 50건 × c 호출 1.5s) 그만큼 HTTP 포트가 안 열려
   *    health probe 가 실패한다. Spring 은 별도 스케줄러 스레드라 기동을 막지 않는다.
   */
  onApplicationBootstrap(): void {
    void this.poll();
  }

  @Interval(POLL_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.publishPending();
    } catch (e) {
      // 주기 작업에서 예외가 새면 이후 tick 이 죽는다. 여기서 반드시 막는다.
      this.logger.error(`outbox poll cycle failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async publishPending(): Promise<void> {
    const events = await this.repository.findPending(this.batchSize);
    if (events.length === 0) {
      return;
    }

    const published: number[] = [];
    for (const event of events) {
      try {
        // key = aggregateId = requestId (spec-parity §9)
        await this.publisher.publish(event.aggregateId, event.payload);
        published.push(event.id);
      } catch (e) {
        // publish 실패 — status 유지(PENDING) → 다음 주기 재시도.
        this.logger.warn(
          `outbox publish failed (will retry): id=${event.id}, type=${event.eventType} reason=${String(e)}`,
        );
      }
    }

    if (published.length > 0) {
      await this.repository.markPublished(published, new Date());
    }
  }
}
