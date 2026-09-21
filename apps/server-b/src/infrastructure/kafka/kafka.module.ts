/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Spring Kafka(Java) ↔ kafkajs(Node) 기본값 대조표
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 포팅에서 가장 위험한 지점은 "원본 yml 에 안 적혀 있던 값" 이다. Java 쪽 기본값에 기대고 있던
 * 동작이 kafkajs 의 다른 기본값을 만나면 **설정을 안 건드렸는데 동작이 바뀐다**.
 * 아래 표의 kafkajs 열은 전부 `node_modules/kafkajs/src` 소스로 확인한 값이다 (v2.2.x).
 * Java 열은 Boot 3.5 가 관리하는 kafka-clients 3.x 기준이다.
 *
 * ■ Producer
 * ┌──────────────────────────────────┬────────────┬──────────┬──────────────────────────────────┐
 * │ 설정                              │ Java 기본   │ 원본 yml │ kafkajs                           │
 * ├──────────────────────────────────┼────────────┼──────────┼──────────────────────────────────┤
 * │ acks                             │ all        │ all      │ send({acks}) 기본 -1(=all) ✅ 동일 │
 * │ enable.idempotence               │ true       │ true     │ idempotent 기본 **false** ⚠️       │
 * │ retries                          │ MAX_VALUE  │ 5        │ idempotent 시 MAX_SAFE_INTEGER,   │
 * │                                  │            │          │ 아니면 5. 우리는 5 명시 ⚠️ 경고 발생│
 * │ max.in.flight.requests.per.conn  │ 5          │ 5        │ maxInFlightRequests 기본 **무제한**│
 * │ request.timeout.ms               │ 30000      │ 5000     │ requestTimeout 기본 30000 (client)│
 * │ delivery.timeout.ms              │ 120000     │ 30000    │ **등가 없음**                      │
 * │ linger.ms                        │ 0          │ 5        │ **등가 없음** (send 단위 배칭)      │
 * │ batch.size                       │ 16384      │ (b만 설정)│ **등가 없음**                      │
 * │ compression.type                 │ none       │ (b만 lz4)│ GZIP 만 구현. **LZ4/Snappy/ZSTD 는 │
 * │                                  │            │          │ KafkaJSNotImplemented** 를 던진다  │
 * └──────────────────────────────────┴────────────┴──────────┴──────────────────────────────────┘
 *
 * ■ Consumer  (⚠️ 표시는 기본값이 달라 명시 설정이 필요한 것)
 * ┌──────────────────────────────────┬────────────┬──────────┬──────────────────────────────────┐
 * │ 설정                              │ Java 기본   │ 원본 yml │ kafkajs                           │
 * ├──────────────────────────────────┼────────────┼──────────┼──────────────────────────────────┤
 * │ max.poll.records                 │ 500        │ 10       │ **등가 없음** — 배치는 바이트 기준  │
 * │                                  │            │          │ (maxBytesPerPartition 1MB) ⚠️     │
 * │ auto.offset.reset                │ latest     │ earliest │ fromBeginning 기본 **false** ⚠️    │
 * │ enable.auto.commit               │ true       │ false    │ autoCommit 기본 true.             │
 * │                                  │            │          │ **false 로 두면 커밋 경로가 전부   │
 * │                                  │            │          │ 죽는다** ⚠️ (아래 주의 2)          │
 * │ auto.commit.interval.ms          │ 5000       │ —        │ autoCommitInterval 기본 null      │
 * │ ack-mode (Spring)                │ BATCH      │ RECORD   │ 등가 없음 → threshold 1 로 흉내    │
 * │ session.timeout.ms               │ 45000      │ 45000    │ sessionTimeout 기본 **30000** ⚠️   │
 * │ max.poll.interval.ms             │ 300000     │ 300000   │ rebalanceTimeout 기본 **60000** ⚠️ │
 * │ heartbeat.interval.ms            │ 3000       │ —        │ heartbeatInterval 3000 ✅ 동일     │
 * │ max.partition.fetch.bytes        │ 1048576    │ —        │ maxBytesPerPartition 1MB ✅ 동일   │
 * │ fetch.max.bytes                  │ 52428800   │ —        │ maxBytes 10MB (더 작음)           │
 * │ isolation.level                  │ read_uncom.│ read_com.│ isolationLevel 기본               │
 * │                                  │            │          │ **READ_COMMITTED** ✅ 원본과 일치  │
 * │ listener.concurrency (Spring)    │ 1          │ 1        │ partitionsConsumedConcurrently 1  │
 * └──────────────────────────────────┴────────────┴──────────┴──────────────────────────────────┘
 *
 * ■ 이 차이 때문에 실제로 터졌던 두 가지 (docs/kafka-consumer-incident.md 참고)
 *   1. `eachBatchAutoResolve` — kafkajs 전용 옵션이고 **기본 true**. Java 에는 대응 개념이 없다.
 *      true 면 eachBatch 가 정상 종료할 때 배치의 마지막 오프셋을 통째로 resolve 하므로,
 *      throttle 로 남겨둔 레코드가 "처리 완료" 로 표시되어 영구 유실된다.
 *   2. `autoCommit: false` + 인자 없는 `commitOffsetsIfNecessary()` = **영구 no-op**.
 *      Java 의 `enable.auto.commit: false` + ack-mode RECORD 를 그대로 옮기면 오프셋이
 *      한 번도 커밋되지 않는다.
 *
 * ■ 미이관으로 남긴 것 (kafkajs 에 등가 없음 — 사이징 단계에서 Node 기준 재측정 대상)
 *   `linger.ms`, `batch.size`, `delivery.timeout.ms`, `max.in.flight.requests.per.connection`,
 *   producer 단위 `request.timeout.ms`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  Global,
  Inject,
  Logger,
  Module,
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
 * kafkajs 클라이언트 + 토픽 생성 (원본 server-b `KafkaConfig` 의 `NewTopic` 빈 자리).
 *
 * ⚠️ 위 대조표는 **server-c 의 것과 동일한 내용**이다. b 와 c 가 같은 토픽을 쓰고 같은 함정을
 *    공유하므로 두 앱 모두에서 바로 보이도록 의도적으로 중복해 둔다.
 *
 * `@nestjs/microservices` 대신 kafkajs 를 직접 감싸는 이유는 ADR-N02 참고 —
 * ADR-009 의 consumer throttle 을 재현하려면 `eachBatch` + 오프셋 제어가 필요하다.
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
          clientId: 'server-b',
          brokers: (process.env.KAFKA_BOOTSTRAP ?? 'localhost:29092').split(
            ',',
          ),
          logLevel: logLevel.WARN,
        }),
    },
  ],
  exports: [KAFKA_CLIENT],
})
export class KafkaModule implements OnModuleInit {
  private readonly logger = new Logger(KafkaModule.name);

  constructor(@Inject(KAFKA_CLIENT) private readonly kafka: Kafka) {}

  /**
   * 토픽 보장. 원본 yml 의 `spring.kafka.admin.fail-fast: false` 에 대응해
   * **실패해도 부팅을 막지 않는다** — server-c 는 API 서버이기도 해서 브로커가 없어도
   * redeem/조회는 떠 있어야 한다. 토픽이 없으면 consumer 가 재연결하며 기다린다.
   *
   * (producer/consumer 의 연결 정리는 각자 `OnApplicationShutdown` 에서 한다.)
   */
  onModuleInit(): void {
    // ⚠️ await 하지 않는다. 원본 `admin.operation-timeout: 5s` 는 부팅 지연 상한이기도 한데
    //    kafkajs admin 은 기본 재시도만으로 10초 넘게 붙잡는다. producer/consumer 와 마찬가지로
    //    토픽 보장은 백그라운드로 돌린다.
    void this.ensureTopics();
  }

  private async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.createTopics({
        topics: [kafkaTopics.issueRequest, kafkaTopics.issueResult].map(
          (topic) => ({
            topic,
            numPartitions: kafkaTopics.partitions,
            replicationFactor: kafkaTopics.replicationFactor,
          }),
        ),
      });
      this.logger.log(
        `kafka topics ensured: ${kafkaTopics.issueRequest}, ${kafkaTopics.issueResult}`,
      );
    } catch (e) {
      this.logger.warn(`kafka topic setup failed (continuing): ${String(e)}`);
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }
}
