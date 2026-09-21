import {
  assertIssueRequestPayload,
  type CouponIssueRequestPayload,
} from '@app/common';
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
 * **ADR-009 throttle 재현** (1 vCPU MySQL-C 보호) — kafkajs 로 옮길 때 세 옵션이 맞물려야 한다:
 *
 * | 원본 (Spring Kafka)      | 여기 |
 * |---|---|
 * | `max-poll-records: 10`   | `eachBatchAutoResolve: false` + 배치당 10건 처리 후 중단 |
 * | `listener.concurrency: 1`| `partitionsConsumedConcurrently: 1` |
 * | `ack-mode: RECORD`       | `autoCommitThreshold: 1` + 레코드마다 `resolveOffset` → `commitOffsetsIfNecessary()` |
 *
 * ⚠️ **`eachBatchAutoResolve` 를 반드시 false 로 둔다.** 기본값 true 면 `eachBatch` 가 정상 종료할 때
 *    kafkajs 가 `batch.lastOffset()` 을 통째로 resolve 한다 (`runner.js:336`). throttle 로 처리하지 않고
 *    남겨둔 레코드까지 "처리 완료" 로 표시되어 **영구 유실**된다. kafkajs 의 배치 크기는
 *    `maxBytesPerPartition`(기본 1MB) 기준이라 부하 시 10건을 쉽게 넘는다.
 *
 * ⚠️ **`autoCommit: false` 로 두면 오프셋이 영원히 커밋되지 않는다.** 인자 없는
 *    `commitOffsetsIfNecessary()` 는 `autoCommitInterval`/`autoCommitThreshold` 가 둘 다 null 이면
 *    no-op 이고 (`offsetManager/index.js:200-213`), `autoCommit: false` 일 때 그 둘의 기본값이 null 이다.
 *    그래서 `autoCommit: true` + `autoCommitThreshold: 1` 로 "레코드 1건마다 커밋" 을 만든다.
 */
@Injectable()
export class CouponIssueRequestConsumer
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(CouponIssueRequestConsumer.name);
  private consumer!: Consumer;
  private startPromise?: Promise<void>;
  private stopped = false;

  /** 원본 `max-poll-records: 10`. */
  private readonly maxRecordsPerBatch = Number(
    process.env.KAFKA_MAX_POLL_RECORDS ?? 10,
  );
  /** 원본 `listener.concurrency: 1`. */
  private readonly concurrency = Number(
    process.env.KAFKA_CONSUMER_CONCURRENCY ?? 1,
  );
  /**
   * 원본 Spring Kafka `DefaultErrorHandler` 의 기본 정책(FixedBackOff, 총 10회 시도)에 대응.
   * 소진되면 ERROR 로그를 남기고 **오프셋을 전진**시킨다 — 그러지 않으면 poison message 하나가
   * 파티션 전체를 영구히 막는다 (실제로 관측됨).
   */
  private readonly maxDeliveryAttempts = Number(
    process.env.KAFKA_MAX_DELIVERY_ATTEMPTS ?? 10,
  );
  /** 커밋 주기 (실험용 노브). 1 = ack-mode RECORD. */
  private readonly commitThreshold = Number(
    process.env.KAFKA_COMMIT_THRESHOLD ?? 1,
  );

  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafka: Kafka,
    private readonly processor: CouponIssueProcessor,
  ) {}

  /**
   * ⚠️ consumer 기동을 **await 하지 않는다.** 원본의 `@KafkaListener` 컨테이너는 별도 스레드에서
   * 시작하고 브로커가 없으면 백그라운드에서 재시도할 뿐, 애플리케이션 기동을 막지 않는다.
   * 여기서 `await connect()` 를 하면 브로커 장애가 곧 부팅 실패가 되어
   * server-c 의 HTTP API(redeem / 내 쿠폰 / 이벤트 조회)까지 함께 죽는다.
   *
   * 테스트는 `whenStarted()` 로 기동 완료를 기다린다.
   */
  onModuleInit(): void {
    this.startPromise = this.startWithRetry();
  }

  /** 기동 완료(또는 실패)까지 기다린다 — 테스트 전용. */
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
      // 원본 group-id 그대로 — 바꾸면 오프셋이 초기화되어 이미 처리한 메시지를 다시 먹는다.
      groupId: 'coupon-issue-server-c',
      // 원본 session.timeout.ms: 45000
      sessionTimeout: 45000,
      // 원본 max.poll.interval.ms: 300000 — 비관적 락 대기가 길어져도 리밸런스가 나지 않도록.
      rebalanceTimeout: 300000,
      maxWaitTimeInMs: 500,
    });

    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: kafkaTopics.issueRequest,
      // 원본 auto-offset-reset: earliest
      fromBeginning: true,
    });

    await this.consumer.run({
      // ack-mode RECORD — threshold 1 이라 resolve 된 레코드마다 커밋된다.
      autoCommit: true,
      autoCommitThreshold: this.commitThreshold,
      // throttle 로 남겨둔 레코드가 유실되지 않도록 반드시 false (클래스 주석 참고).
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: this.concurrency,
      // payload 의 메서드를 구조분해하지 않는다 — lint(unbound-method) 회피 + 출처를 명확히.
      eachBatch: async (payload) => {
        let processed = 0;
        for (const message of payload.batch.messages) {
          if (!payload.isRunning() || payload.isStale()) break;
          // ADR-009 throttle — 한 번에 max-poll-records 만큼만. 나머지는 다음 fetch 로 넘어간다
          // (eachBatchAutoResolve: false 라 resolve 되지 않는다).
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
      `consuming ${kafkaTopics.issueRequest} (maxRecords=${this.maxRecordsPerBatch}, concurrency=${this.concurrency})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.startPromise?.catch(() => undefined);
    // 이게 없으면 consumer 가 group 에 rebalance 흔적을 남기고 죽는다 (ADR-N02).
    await this.consumer?.disconnect().catch(() => undefined);
  }

  /**
   * 한 레코드를 재시도 한도 안에서 처리한다.
   *
   * 원본은 리스너 밖으로 나온 예외를 `DefaultErrorHandler` 가 받아 backoff 재시도 후
   * 로그를 남기고 레코드를 건너뛴다. 여기서 같은 실패 모드를 만든다 —
   * 예외를 `eachBatch` 밖으로 던지면 kafkajs 가 배치를 통째로 무한 재시도해 파티션이 멈춘다.
   */
  private async deliver(
    value: Buffer | null,
    offset: string,
    partition: number,
  ): Promise<void> {
    const payload = this.parse(value);
    if (payload === null) {
      return; // 형식 자체가 틀린 메시지 — 재시도해도 같으므로 skip (원본과 동일)
    }

    for (let attempt = 1; attempt <= this.maxDeliveryAttempts; attempt++) {
      try {
        await this.processor.process(payload);
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

  /**
   * 원본은 Jackson 이 `CouponIssueRequestPayload` record 를 만들면서 compact constructor 검증까지
   * 수행하고, 실패하면 `JsonProcessingException` 하위 예외가 되어 warn + skip 된다.
   * JSON 파싱만 해서는 `userId: 0` 같은 메시지가 트랜잭션까지 내려가므로 검증을 함께 태운다.
   */
  private parse(value: Buffer | null): CouponIssueRequestPayload | null {
    if (value === null) {
      this.logger.warn('null message value — skipping');
      return null;
    }

    const raw = value.toString();
    try {
      const parsed = JSON.parse(raw) as CouponIssueRequestPayload;
      assertIssueRequestPayload(parsed);
      return parsed;
    } catch (e) {
      this.logger.warn(
        `malformed coupon-issue-request — skipping: ${raw} (${String(e)})`,
      );
      return null;
    }
  }
}
