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
 * `OutboxPoller` 가 호출하는 Kafka publish — `coupon-issue-result` 토픽
 * (원본 `IssueResultPublisher`).
 *
 * 원본 server-c yml 대비:
 *  - 이관: `acks=all`(send 의 acks:-1), `enable.idempotence=true`, `retries=5`
 *  - **미이관** (kafkajs 에 등가 옵션이 없음): `linger.ms=5`, `delivery.timeout.ms=30000`,
 *    `max.in.flight.requests.per.connection=5`, `request.timeout.ms=5000`.
 *    배치 지연/처리량 특성이 원본과 다를 수 있다 — 사이징 단계에서 재측정 대상.
 *
 * 실패는 예외로 올린다 — poller 가 status 를 PENDING 으로 남겨 다음 주기에 재시도한다.
 */
@Injectable()
export class IssueResultPublisher
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(IssueResultPublisher.name);
  private producer!: Producer;
  private connected = false;
  private connecting?: Promise<void>;
  private readonly sendTimeoutMs = Number(
    process.env.KAFKA_SEND_TIMEOUT_MS ?? 3000,
  );

  constructor(@Inject(KAFKA_CLIENT) private readonly kafka: Kafka) {}

  /**
   * ⚠️ 연결을 **await 하지 않는다.** 원본의 `KafkaTemplate` 은 lazy 라 브로커가 없어도
   * 애플리케이션이 기동하고 HTTP(redeem/조회)는 정상 동작한다. 여기서 `await connect()` 를 하면
   * 브로커 장애가 곧 부팅 실패가 되어 c 의 API 까지 죽는다.
   *
   * 연결 전에 들어온 publish 는 예외가 되고, `OutboxPoller` 가 row 를 PENDING 으로 남겨
   * 다음 주기에 재시도한다 (at-least-once 유지).
   */
  async onModuleInit(): Promise<void> {
    this.producer = this.kafka.producer({
      // acks=all + idempotence — kafkajs 는 idempotent 를 켜면 acks=-1(all) 을 강제한다.
      idempotent: true,
      // 원본 retries: 5. idempotent 와 함께 쓰면 kafkajs 가 EoS 보장 관련 경고를 남기는데,
      // 원본 수치를 지키는 쪽을 택했다 (무제한 재시도는 1 vCPU 에서 더 위험).
      retry: { retries: 5 },
    });
    // 백그라운드 연결. 실패해도 부팅을 막지 않는다 — publish 시점에 재시도된다.
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

  /**
   * @param key   `outbox_event.aggregate_id` — 발급 결과에서는 **requestId** 다 (spec-parity §9)
   * @param value JSON 직렬화된 `CouponIssueResultPayload`
   */
  async publish(key: string, value: string): Promise<void> {
    if (!this.connected) {
      // 최초 연결이 실패했던 경우 — 여기서 다시 시도한다. 또 실패하면 예외가 그대로 올라가
      // poller 가 PENDING 으로 남기고 다음 주기에 재시도한다.
      await this.producer.connect();
      this.connected = true;
    }

    await this.producer.send({
      topic: kafkaTopics.issueResult,
      messages: [{ key, value }],
      acks: -1,
      timeout: this.sendTimeoutMs,
    });
  }
}
