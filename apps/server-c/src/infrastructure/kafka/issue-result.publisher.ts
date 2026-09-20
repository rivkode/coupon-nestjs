import {
  Inject,
  Injectable,
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
  private producer!: Producer;
  private readonly sendTimeoutMs = Number(
    process.env.KAFKA_SEND_TIMEOUT_MS ?? 3000,
  );

  constructor(@Inject(KAFKA_CLIENT) private readonly kafka: Kafka) {}

  async onModuleInit(): Promise<void> {
    this.producer = this.kafka.producer({
      // acks=all + idempotence — kafkajs 는 idempotent 를 켜면 acks=-1(all) 을 강제한다.
      idempotent: true,
      // 원본 retries: 5. idempotent 와 함께 쓰면 kafkajs 가 EoS 보장 관련 경고를 남기는데,
      // 원본 수치를 지키는 쪽을 택했다 (무제한 재시도는 1 vCPU 에서 더 위험).
      retry: { retries: 5 },
    });
    await this.producer.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.producer?.disconnect();
  }

  /**
   * @param key   `outbox_event.aggregate_id` — 발급 결과에서는 **requestId** 다 (spec-parity §9)
   * @param value JSON 직렬화된 `CouponIssueResultPayload`
   */
  async publish(key: string, value: string): Promise<void> {
    await this.producer.send({
      topic: kafkaTopics.issueResult,
      messages: [{ key, value }],
      acks: -1,
      timeout: this.sendTimeoutMs,
    });
  }
}
