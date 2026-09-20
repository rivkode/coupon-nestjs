import type { CouponIssueRequestPayload } from '@app/common';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Kafka, type Consumer } from 'kafkajs';
import { CouponIssueProcessor } from '../../application/coupon-issue.processor';
import { KAFKA_CLIENT, kafkaTopics } from './kafka.module';

/**
 * b → c `coupon-issue-request` consumer (원본 `CouponIssueRequestConsumer`).
 * ADR-003 의 비관적 락 트랜잭션을 호출한다.
 *
 * **ADR-009 throttle 재현** (1 vCPU MySQL-C 보호):
 *  - 원본 `max-poll-records: 10` → `eachBatch` 로 받되 한 번에 처리하는 레코드 수를 직접 제한
 *  - 원본 `concurrency: 1` → partitionsConsumedConcurrently = 1
 *  - 원본 `ack-mode: RECORD` → `autoCommit: false` + 레코드 1건마다 `resolveOffset`
 *
 * `eachMessage` 가 아니라 `eachBatch` 를 쓰는 이유가 여기 있다 — `eachMessage` 는 배치 크기와
 * 커밋 시점을 제어할 수 없어 throttle 이 성립하지 않는다 (ADR-N02).
 */
@Injectable()
export class CouponIssueRequestConsumer
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(CouponIssueRequestConsumer.name);
  private consumer!: Consumer;

  /** 원본 `max-poll-records: 10`. */
  private readonly maxRecordsPerBatch = Number(
    process.env.KAFKA_MAX_POLL_RECORDS ?? 10,
  );
  /** 원본 `listener.concurrency: 1`. */
  private readonly concurrency = Number(
    process.env.KAFKA_CONSUMER_CONCURRENCY ?? 1,
  );

  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafka: Kafka,
    private readonly processor: CouponIssueProcessor,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumer = this.kafka.consumer({
      // 원본 group-id 그대로 — 바꾸면 오프셋이 초기화되어 이미 처리한 메시지를 다시 먹는다.
      groupId: 'coupon-issue-server-c',
      // 원본 session.timeout.ms / max.poll.interval.ms
      sessionTimeout: 45000,
      maxWaitTimeInMs: 500,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: kafkaTopics.issueRequest,
      // 원본 auto-offset-reset: earliest
      fromBeginning: true,
    });

    await this.consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: this.concurrency,
      // payload 의 메서드를 구조분해하지 않는다 — kafkajs 가 바인딩해 주긴 하지만
      // lint(unbound-method)가 걸리고, 호출부만 봐서는 출처가 불분명해진다.
      eachBatch: async (payload) => {
        let processed = 0;
        for (const message of payload.batch.messages) {
          if (!payload.isRunning() || payload.isStale()) break;
          // ADR-009 throttle — 한 번에 max-poll-records 만큼만 처리하고 루프를 넘긴다.
          if (processed >= this.maxRecordsPerBatch) break;

          await this.handle(message.value);

          // ack-mode RECORD — 레코드 1건 처리 직후 오프셋 확정.
          payload.resolveOffset(message.offset);
          await payload.heartbeat();
          processed++;
        }
        await payload.commitOffsetsIfNecessary();
      },
    });

    this.logger.log(
      `consuming ${kafkaTopics.issueRequest} (maxRecords=${this.maxRecordsPerBatch}, concurrency=${this.concurrency})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // 이게 없으면 consumer 가 group 에 rebalance 흔적을 남기고 죽는다 (ADR-N02).
    await this.consumer?.disconnect();
  }

  private async handle(value: Buffer | null): Promise<void> {
    if (value === null) {
      this.logger.warn('null message value — skipping');
      return;
    }

    let payload: CouponIssueRequestPayload;
    const raw = value.toString();
    try {
      payload = JSON.parse(raw) as CouponIssueRequestPayload;
    } catch (e) {
      // 원본과 동일 — 파싱 실패는 건너뛴다 (재시도해도 똑같이 실패한다).
      this.logger.warn(
        `malformed coupon-issue-request — skipping: ${raw} (${String(e)})`,
      );
      return;
    }

    await this.processor.process(payload);
  }
}
