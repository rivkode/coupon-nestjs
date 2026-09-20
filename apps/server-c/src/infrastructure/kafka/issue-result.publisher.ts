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
 * producer 설정은 원본 server-c yml 을 그대로 옮긴다 (ADR-002):
 * `acks=all`, `enable.idempotence=true`, `retries=5`, `request.timeout.ms=5000`,
 * `delivery.timeout.ms=30000`, `linger.ms=5`.
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
      retry: { retries: 5 },
      // 원본 delivery.timeout.ms
      transactionTimeout: 30000,
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
