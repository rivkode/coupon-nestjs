import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Kafka, logLevel } from 'kafkajs';

export const KAFKA_CLIENT = Symbol('KAFKA_CLIENT');

export const kafkaTopics = {
  issueRequest: process.env.KAFKA_TOPIC_ISSUE_REQUEST ?? 'coupon-issue-request',
  issueResult: process.env.KAFKA_TOPIC_ISSUE_RESULT ?? 'coupon-issue-result',
  partitions: Number(process.env.KAFKA_TOPIC_PARTITIONS ?? 3),
  replicationFactor: Number(process.env.KAFKA_TOPIC_RF ?? 1),
} as const;

/**
 * kafkajs 클라이언트 + 토픽 생성 (원본 `KafkaConfig` 의 `NewTopic` 빈 자리).
 *
 * `@nestjs/microservices` 대신 kafkajs 를 직접 감싸는 이유는 ADR-N02 참고 —
 * ADR-009 의 consumer throttle 을 재현하려면 `eachBatch` + 수동 커밋 제어가 필요하다.
 *
 * 브로커는 `auto.create.topics.enable=false` 라 토픽을 여기서 명시적으로 만든다.
 */
@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      useFactory: (): Kafka =>
        new Kafka({
          clientId: 'server-c',
          brokers: (process.env.KAFKA_BOOTSTRAP ?? 'localhost:29092').split(
            ',',
          ),
          logLevel: logLevel.WARN,
        }),
    },
  ],
  exports: [KAFKA_CLIENT],
})
export class KafkaModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaModule.name);

  constructor(@Inject(KAFKA_CLIENT) private readonly kafka: Kafka) {}

  async onModuleInit(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        topics: [kafkaTopics.issueRequest, kafkaTopics.issueResult].map(
          (topic) => ({
            topic,
            numPartitions: kafkaTopics.partitions,
            replicationFactor: kafkaTopics.replicationFactor,
          }),
        ),
      });
    } finally {
      await admin.disconnect();
    }
    this.logger.log(
      `kafka topics ensured: ${kafkaTopics.issueRequest}, ${kafkaTopics.issueResult}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // 개별 producer/consumer 는 각자 정리한다. 여기서는 훅이 걸려 있다는 것만 보장.
  }
}
