import {
  assertIssueResultPayload,
  type CouponIssueResultPayload,
  type CouponIssueResultStatus,
} from '@app/common';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Kafka, type Consumer } from 'kafkajs';
import { PendingIssueStore } from '../../domain/pending-issue.store';
import type { IssuePendingStatus } from '../../domain/statuses';
import { KAFKA_CLIENT, kafkaTopics } from './kafka.module';

/**
 * c → b `coupon-issue-result` consumer (원본 `CouponIssueResultConsumer`). ADR-009.
 *
 * 원본 server-b yml 의 throttle 은 c 보다 느슨하다 — **Redis HSET 처리만** 하기 때문이다:
 *  - `max-poll-records: 50` (c 는 10)
 *  - `concurrency: 1`, `ack-mode: RECORD`, `auto-offset-reset: earliest`
 *
 * ⚠️ `eachBatchAutoResolve: false` 와 `autoCommitThreshold: 1` 이 반드시 있어야 한다 —
 *    빠지면 throttle 로 남긴 레코드가 유실되거나 오프셋이 커밋되지 않는다.
 *    (docs/kafka-consumer-incident.md)
 */
@Injectable()
export class CouponIssueResultConsumer
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(CouponIssueResultConsumer.name);
  private consumer!: Consumer;
  private startPromise?: Promise<void>;
  private stopped = false;

  /** 원본 server-b `max-poll-records: 50`. */
  private readonly maxRecordsPerBatch = Number(
    process.env.KAFKA_RESULT_MAX_POLL_RECORDS ?? 50,
  );
  private readonly concurrency = Number(
    process.env.KAFKA_CONSUMER_CONCURRENCY ?? 1,
  );
  private readonly maxDeliveryAttempts = Number(
    process.env.KAFKA_MAX_DELIVERY_ATTEMPTS ?? 10,
  );

  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafka: Kafka,
    private readonly store: PendingIssueStore,
  ) {}

  /** 기동을 await 하지 않는다 — 브로커 장애가 부팅 실패가 되면 안 된다. */
  onModuleInit(): void {
    this.startPromise = this.startWithRetry();
  }

  /** 기동 완료(또는 실패)까지 대기 — 테스트 전용. */
  async whenStarted(): Promise<void> {
    await this.startPromise;
  }

  /**
   * 브로커/토픽이 준비될 때까지 **계속 재시도**한다.
   *
   * ⚠️ 한 번 실패하고 끝내면 안 된다. 원본의 `@KafkaListener` 컨테이너는 브로커가 없거나
   *    토픽이 아직 없어도 백그라운드에서 무한 재시도하다가 붙는다. 여기서 포기하면
   *    "앱은 떠 있는데 메시지를 영원히 소비하지 않는" 상태가 된다 — 실제로 토픽 생성과
   *    구독의 레이스에서 `This server does not host this topic-partition` 로 죽었다.
   */
  private async startWithRetry(): Promise<void> {
    const MAX_BACKOFF_MS = 30_000;
    let backoffMs = 1_000;

    while (!this.stopped) {
      try {
        await this.start();
        return;
      } catch (e) {
        // 부분 연결 상태가 남지 않도록 정리하고 다음 시도에서 새로 만든다.
        await this.consumer?.disconnect().catch(() => undefined);
        if (this.stopped) return;
        this.logger.warn(
          `kafka consumer start failed (retrying in ${backoffMs}ms): ${String(e)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async start(): Promise<void> {
    this.consumer = this.kafka.consumer({
      // 원본 group-id 그대로.
      groupId: 'coupon-result-server-b',
      sessionTimeout: 45000,
      rebalanceTimeout: 300000,
      maxWaitTimeInMs: 500,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: kafkaTopics.issueResult,
      fromBeginning: true,
    });

    await this.consumer.run({
      autoCommit: true,
      autoCommitThreshold: 1,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: this.concurrency,
      eachBatch: async (payload) => {
        let processed = 0;
        for (const message of payload.batch.messages) {
          if (!payload.isRunning() || payload.isStale()) break;
          if (processed >= this.maxRecordsPerBatch) break;

          await this.deliver(
            message.value,
            message.offset,
            payload.batch.partition,
          );

          payload.resolveOffset(message.offset);
          await payload.commitOffsetsIfNecessary();
          await payload.heartbeat();
          processed++;
        }
      },
    });

    this.logger.log(
      `consuming ${kafkaTopics.issueResult} (maxRecords=${this.maxRecordsPerBatch}, concurrency=${this.concurrency})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.startPromise?.catch(() => undefined);
    await this.consumer?.disconnect().catch(() => undefined);
  }

  private async deliver(
    value: Buffer | null,
    offset: string,
    partition: number,
  ): Promise<void> {
    const payload = this.parse(value);
    if (payload === null) {
      return;
    }

    for (let attempt = 1; attempt <= this.maxDeliveryAttempts; attempt++) {
      try {
        await this.store.markResult(
          payload.userId,
          payload.couponTypeId,
          mapStatus(payload.status),
          payload.couponCode,
        );
        return;
      } catch (e) {
        if (attempt === this.maxDeliveryAttempts) {
          this.logger.error(
            `giving up after ${attempt} attempts — skipping record: ` +
              `partition=${partition}, offset=${offset}, requestId=${payload.requestId} reason=${String(e)}`,
          );
          return;
        }
        this.logger.warn(
          `delivery attempt ${attempt} failed (will retry): requestId=${payload.requestId} reason=${String(e)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private parse(value: Buffer | null): CouponIssueResultPayload | null {
    if (value === null) {
      this.logger.warn('null message value — skipping');
      return null;
    }
    const raw = value.toString();
    try {
      const parsed = JSON.parse(raw) as CouponIssueResultPayload;
      assertIssueResultPayload(parsed);
      return parsed;
    } catch (e) {
      this.logger.warn(
        `malformed coupon-issue-result — skipping: ${raw} (${String(e)})`,
      );
      return null;
    }
  }
}

/** 원본 `CouponIssueResultConsumer#map` — wire 상태를 Redis 상태로. */
function mapStatus(status: CouponIssueResultStatus): IssuePendingStatus {
  switch (status) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'SOLD_OUT':
      return 'SOLD_OUT';
    case 'FAILED':
      return 'FAILED';
    default: {
      // 누락을 컴파일 타임에 잡는다.
      const exhaustive: never = status;
      throw new Error(`unknown result status: ${String(exhaustive)}`);
    }
  }
}
