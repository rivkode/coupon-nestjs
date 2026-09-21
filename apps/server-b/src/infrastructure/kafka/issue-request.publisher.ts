import {
  assertIssueRequestPayload,
  withTimeout,
  type CouponIssueRequestPayload,
} from '@app/common';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Kafka, type Producer } from 'kafkajs';
import { KAFKA_CLIENT, kafkaTopics } from './kafka.module';

/**
 * b → c `coupon-issue-request` publisher (원본 `IssueRequestPublisher`). ADR-008.
 *
 * 원본 server-b yml 대비:
 *  - 이관: `acks=all`(send 의 acks:-1), `enable.idempotence=true`, `retries=5`
 *  - **미이관** (kafkajs 에 등가 없음): `linger.ms=5`, `batch.size=32768`,
 *    `compression.type=lz4`, `delivery.timeout.ms=30000`,
 *    `max.in.flight.requests.per.connection=5`, `request.timeout.ms=5000`.
 *    기본값 차이는 `kafka.module.ts` 상단 대조표 참고.
 *
 * **timeout 이 두 개인 이유** (ADR-008):
 *  - 기본 흐름: `send-timeout-ms` 3000
 *  - 스케줄러 재발행: `scheduler-send-timeout-ms` **500**
 *    스케줄러는 `fixed-delay` 1s 로 batch 50 을 도는데, 건당 3s 를 기다리면
 *    누적 latency 가 cycle 을 압도한다. 한 번 실패해도 다음 cycle 이 재시도하므로 짧게 자른다.
 */
@Injectable()
export class IssueRequestPublisher
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(IssueRequestPublisher.name);
  private producer!: Producer;
  private connected = false;
  private connecting?: Promise<void>;

  private readonly sendTimeoutMs = Number(
    process.env.KAFKA_SEND_TIMEOUT_MS ?? 3000,
  );
  private readonly schedulerSendTimeoutMs = Number(
    process.env.KAFKA_SCHEDULER_SEND_TIMEOUT_MS ?? 500,
  );

  constructor(@Inject(KAFKA_CLIENT) private readonly kafka: Kafka) {}

  /** 연결을 await 하지 않는다 — 브로커 장애가 부팅 실패가 되면 안 된다 (server-c 와 동일한 이유). */
  async onModuleInit(): Promise<void> {
    this.producer = this.kafka.producer({
      idempotent: true,
      retry: { retries: 5 },
    });
    this.connecting = this.producer
      .connect()
      .then(() => {
        this.connected = true;
      })
      .catch((e: unknown) => {
        this.logger.warn(
          `kafka producer connect failed (will retry on publish): ${String(e)}`,
        );
      });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
  }

  /** 기본 흐름 (accept) 용. */
  async publish(payload: CouponIssueRequestPayload): Promise<void> {
    await this.publishWithTimeout(payload, this.sendTimeoutMs);
  }

  /** ADR-008 스케줄러 재발행용 — 짧은 timeout. */
  async publishForScheduler(payload: CouponIssueRequestPayload): Promise<void> {
    await this.publishWithTimeout(payload, this.schedulerSendTimeoutMs);
  }

  private async publishWithTimeout(
    payload: CouponIssueRequestPayload,
    timeoutMs: number,
  ): Promise<void> {
    // 원본 record 의 compact constructor 검증. 실패하면 publish 하지 않고 예외를 올린다 —
    // 호출 측이 그것을 삼켜서 "잘못된 메시지는 토픽에 나가지 않는다" 는 원본 동작이 된다.
    assertIssueRequestPayload(payload);

    // ⚠️ `send({ timeout })` 만으로는 호출 대기가 제한되지 않는다 — 그 값은 브로커의 ack 대기값이고
    //    로컬 재시도(retry.retries)나 미연결 시의 connect() 대기를 끊지 못한다.
    //    원본은 `future.get(timeoutMs)` 로 호출 스레드를 하드 바운드했으므로 같은 의미로 감싼다.
    //    이 상한이 없으면 스케줄러의 500ms 가드가 무력해져 cycle 이 폭주한다 (ADR-008).
    await withTimeout(
      this.sendInternal(payload, timeoutMs),
      timeoutMs,
      `kafka send timed out after ${timeoutMs}ms: requestId=${payload.requestId}`,
    );
  }

  private async sendInternal(
    payload: CouponIssueRequestPayload,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    await this.producer.send({
      topic: kafkaTopics.issueRequest,
      // key = userId — 같은 user 의 이벤트에 partition 순서를 보장한다 (spec-parity §9).
      messages: [
        { key: String(payload.userId), value: JSON.stringify(payload) },
      ],
      acks: -1,
      timeout: timeoutMs,
    });
  }
}
