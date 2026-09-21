# Kafka Consumer 결함 보고서 — 메시지 유실 · 오프셋 미커밋

| | |
|---|---|
| 발견 | 2026-09-21, server-c 포팅(2단계) 직후 원본 대조 중 |
| 영향 범위 | `apps/server-c/src/infrastructure/kafka/coupon-issue-request.consumer.ts` |
| 심각도 | **Critical** ×2 (데이터 유실 / 오프셋 정합성) |
| 도입 커밋 | `d17ce1c` (2단계 server-c 포팅) |
| 수정 커밋 | `8a16a5a` (결함 ①②), 후속 (브로커 비차단 기동) |
| 근본 원인 | Spring Kafka 와 kafkajs 의 **기본값 차이**를 확인하지 않고 옵션을 1:1로 옮김 |

---

## 0. 한 줄 요약

Java 원본의 `max-poll-records: 10` / `ack-mode: RECORD` 를 kafkajs 로 옮기면서
`eachBatchAutoResolve`(기본 `true`)를 끄지 않았고 `autoCommit: false` 를 그대로 썼다.
그 결과 **부하 상황에서 발급 요청이 조용히 사라지고**, **컨슈머 그룹 오프셋이 한 번도 커밋되지 않았다.**

두 결함 모두 기능 테스트로는 드러나지 않았다 — 메시지를 5건만 보냈기 때문이다.

---

## 1. 배경 — 무엇을 재현하려 했나

원본 `server-c/src/main/resources/application.yml`:

```yaml
spring:
  kafka:
    consumer:
      group-id: coupon-issue-server-c
      auto-offset-reset: earliest
      enable-auto-commit: false
      # ADR-009: 1 vCPU MySQL-C 의 비관적 락 처리량을 보호하기 위한 throttle.
      max-poll-records: 10
    listener:
      ack-mode: RECORD
      concurrency: 1
```

이 세 가지가 ADR-009(Rate Limiting / Backpressure, 평가항목 ④)의 핵심이다.
"1 vCPU MySQL-C 가 비관적 락으로 소화할 수 있는 만큼만 consumer 가 먹는다" 는 설계다.

kafkajs 에는 `max.poll.records` 에 해당하는 옵션이 **없다**. 배치는 레코드 수가 아니라
바이트(`maxBytesPerPartition`, 기본 1MB) 기준으로 잡힌다. 그래서 `eachBatch` 로 배치를 받아
루프 안에서 10건만 처리하고 빠져나오는 방식을 택했다.

### 최초 구현 (결함 있음)

```ts
await this.consumer.run({
  autoCommit: false,                              // ← 결함 ②
  partitionsConsumedConcurrently: this.concurrency,
  // eachBatchAutoResolve 미지정 = 기본값 true    // ← 결함 ①
  eachBatch: async (payload) => {
    let processed = 0;
    for (const message of payload.batch.messages) {
      if (processed >= this.maxRecordsPerBatch) break;   // throttle
      await this.handle(message.value);
      payload.resolveOffset(message.offset);
      await payload.heartbeat();
      processed++;
    }
    await payload.commitOffsetsIfNecessary();     // ← 결함 ②
  },
});
```

---

## 2. 결함 ① — throttle 로 건너뛴 메시지가 영구 유실

### 증상

배치 크기가 `max-poll-records`(10)를 넘으면, **11번째 이후 레코드가 처리되지 않은 채 사라진다.**
`user_coupon` row 도, `outbox_event` 도, 결과 이벤트도 생기지 않는다.
사용자 관점에서는 발급 요청이 영원히 `PENDING` 이고, server-b 의 스케줄러가
internal GET 을 호출해도 404 만 반복하다 30초 SLA 후 `FAILED` 로 마감된다.

### 원인

`node_modules/kafkajs/src/consumer/runner.js`:

```js
// :34   기본값
eachBatchAutoResolve = true,

// :334-337
// resolveOffset for the last offset can be disabled to allow the users of eachBatch to
// stop their consumers without resolving unprocessed offsets (issues/18)
if (this.eachBatchAutoResolve) {
  this.consumerGroup.resolveOffset({ topic, partition, offset: batch.lastOffset() })
}
```

`eachBatch` 콜백이 **예외 없이 반환하면** kafkajs 는 배치의 마지막 오프셋을 통째로 resolve 한다.
"콜백이 끝났으니 이 배치는 다 처리된 것" 이라는 전제다.

우리는 throttle 때문에 10건만 처리하고 `break` 로 나왔는데, kafkajs 입장에서는 정상 종료이므로
**나머지 레코드까지 처리 완료로 표시**된다. `offsetManager.nextOffset()` 이 resolvedOffsets 를
기준으로 다음 fetch 위치를 정하므로, 건너뛴 레코드는 다시 읽히지 않는다.

### 왜 Java 에는 없는 문제인가

Spring Kafka 의 `max.poll.records` 는 **poll 단위 자체를 10으로 제한**한다.
리스너는 10건짜리 배치만 받고, 11번째 레코드는 애초에 전달되지 않는다.
"받았지만 처리하지 않고 남겨둔 레코드" 라는 상태가 존재하지 않으므로 유실도 없다.

kafkajs 는 배치를 먼저 받고 소비자가 알아서 처리하는 모델이라, **"남겨둔 것"을 명시하지 않으면
"처리한 것"으로 간주**한다. 이 방향의 차이가 결함의 본질이다.

### 왜 테스트에서 안 걸렸나

초기 e2e 테스트는 메시지를 5건만 보냈다. 배치가 10건을 넘지 않아 `break` 가 발화하지 않았고,
`eachBatchAutoResolve` 가 무엇을 resolve 하든 결과가 같았다.

**부하가 있어야만 드러나는 결함**이었다. 그리고 이 시스템은 애초에 순간 부하를 다루는 게 목적이라,
평가 시나리오에서 정확히 발화했을 것이다.

### 수정

```ts
eachBatchAutoResolve: false,
```

이제 명시적으로 `resolveOffset()` 한 레코드만 전진한다. 처리하지 않고 남긴 레코드는
resolve 되지 않으므로 다음 fetch 에서 다시 내려온다.

### 검증

150건을 한 번에 produce 해서 배치가 10건을 크게 넘도록 만들었다.

| | 수정 전 | 수정 후 |
|---|---|---|
| `user_coupon` row | 일부만 생성 | **150 / 150** |
| `outbox_event` PUBLISHED | 일부만 | **150** |
| 재고 (200 시작) | — | **50** (정확히 150 차감) |

---

## 3. 결함 ② — 오프셋이 한 번도 커밋되지 않음

### 증상

컨슈머 그룹 오프셋이 영원히 `0` 이다. 메시지는 정상 처리되지만:

- 재시작 / 리밸런스마다 `fromBeginning: true` 라 **토픽 전체를 처음부터 재처리**한다.
  중복 발급은 `(user_id, coupon_type_id)` UNIQUE 와 exists 단락이 막아주지만,
  **재처리 경로에서는 outbox 가 생기지 않아 server-b 가 결과를 영영 못 받는다.**
- `consumer lag` 지표가 무의미해진다 (항상 전체 메시지 수).

### 원인

`autoCommit: false` 로 두면 `autoCommitInterval` 과 `autoCommitThreshold` 가 **둘 다 `null`** 이 된다.

`node_modules/kafkajs/src/consumer/index.js`:

```js
const run = async ({
  autoCommit = true,
  autoCommitInterval = null,     // ← 명시하지 않으면 null
  autoCommitThreshold = null,    // ← 명시하지 않으면 null
  ...
```

그런데 인자 없는 `commitOffsetsIfNecessary()` 는 그 둘을 보고 커밋 여부를 정한다.

`node_modules/kafkajs/src/consumer/offsetManager/index.js:200-213`:

```js
async commitOffsetsIfNecessary() {
  const now = Date.now()
  const timeoutReached =
    this.autoCommitInterval != null && now >= this.lastCommit + this.autoCommitInterval
  const thresholdReached =
    this.autoCommitThreshold != null &&
    this.countResolvedOffsets().gte(Long.fromValue(this.autoCommitThreshold))

  if (timeoutReached || thresholdReached) {
    return this.commitOffsets()
  }
}
```

둘 다 `null` 이면 `timeoutReached` 와 `thresholdReached` 가 모두 `false` → **영구 no-op**.

다른 커밋 경로(`runner.autoCommitOffsets()`)에도 `if (this.autoCommit)` 가드가 있어
`autoCommit: false` 일 때는 실행되지 않는다. 즉 **커밋 경로가 전부 닫힌다.**

### 함정의 구조

Java 의 `enable-auto-commit: false` 는 "자동 커밋을 끄고 리스너 컨테이너가 ack-mode 에 따라
직접 커밋한다" 는 뜻이다. 커밋은 계속 일어난다.

kafkajs 의 `autoCommit: false` 는 "**커밋을 아예 하지 않는다**" 는 뜻이다.
직접 커밋하려면 `consumer.commitOffsets()` 를 명시 호출해야 한다.

같은 이름의 설정이 **정반대에 가까운 의미**를 갖는다. 이름만 보고 옮기면 걸린다.

### 수정

`ack-mode: RECORD`(레코드 1건마다 커밋)를 만들려면 `autoCommit` 을 켜고 threshold 를 1로 둔다.

```ts
autoCommit: true,
autoCommitThreshold: 1,   // resolve 된 레코드가 1건 쌓이면 커밋 → ack-mode RECORD
```

그리고 루프 안에서 레코드마다 `resolveOffset()` → `commitOffsetsIfNecessary()` 를 호출한다.
이제 threshold 1이 충족되어 실제 커밋이 발생한다.

### 검증

```
GROUP                 TOPIC                PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
coupon-issue-server-c coupon-issue-request 0          52              52              0
coupon-issue-server-c coupon-issue-request 1          47              47              0
coupon-issue-server-c coupon-issue-request 2          51              51              0
```

- 커밋된 오프셋 합계 150 = 처리한 메시지 수, `LAG 0`
- **재기동 후 재처리 0건** (`user_coupon` 150 유지, 재고 50 유지, 처리 로그 없음)

---

## 4. 함께 드러난 문제

두 결함을 조사하면서 같은 뿌리(기본값/실패모드 차이)를 가진 항목을 더 찾았다.

| 항목 | 원본 | 최초 구현 | 수정 |
|---|---|---|---|
| poison message | Spring `DefaultErrorHandler` 가 backoff 재시도 후 로그 남기고 **skip** | 예외가 `eachBatch` 밖으로 → kafkajs 가 배치 무한 재시도 → **파티션 정지** | 레코드 단위 10회 재시도 후 ERROR 로그 + skip |
| payload 검증 | Jackson 이 record compact constructor 검증까지 수행, 실패 시 warn + skip | `JSON.parse` 만 → `userId: 0` 같은 메시지가 트랜잭션까지 내려감 | `assertIssueRequestPayload()` 를 파싱에 포함 |
| `max.poll.interval.ms` | 300000 | 미이관 (kafkajs `rebalanceTimeout` 기본 60000) | `rebalanceTimeout: 300000` |
| admin `fail-fast` | `false` — 브로커 없어도 앱은 뜬다 | 토픽 생성 실패 시 **부팅 실패** | catch + warn 후 계속 |
| producer 연결 | `KafkaTemplate` 은 lazy | `await producer.connect()` 가 **부팅을 막음** | 백그라운드 연결, publish 시 재시도 |
| consumer 기동 | 리스너 컨테이너가 별도 스레드에서 재시도 | `await consumer.connect()` 가 **부팅을 막음** | 백그라운드 기동 |

`poison message` 무한 재시도는 실제로 관측됐다. 테스트 데이터가 placeholder code 충돌을 일으켰고,
그 레코드가 같은 파티션을 영구히 막았다 (초당 1회씩 같은 INSERT 를 재시도).

### 4.1 "브로커 없이 부팅" 은 세 곳을 다 고쳐야 했다

처음에는 admin 만 고치고 "브로커가 없어도 HTTP 는 뜬다" 고 판단했는데, **실제로 띄워 보니 여전히
안 떴다.** `KAFKA_BOOTSTRAP` 을 없는 포트로 돌려 확인한 결과:

| 수정 단계 | `/actuator/health` |
|---|---|
| 수정 전 | 연결 거부 (앱이 뜨지 않음) |
| admin 만 fail-fast 해제 | 연결 거부 — `producer.connect()` / `consumer.connect()` 가 막고 있었다 |
| 세 곳 모두 비차단화 | **200 `{"status":"UP"}`** — redeem / 이벤트 조회 정상 |

Spring 쪽에서는 이 세 가지가 각각 다른 메커니즘으로 비차단이다 (admin `fail-fast: false`,
`KafkaTemplate` 의 lazy 연결, 리스너 컨테이너의 별도 스레드 + 백그라운드 재시도).
kafkajs 에는 그런 기본 동작이 없어 **셋 다 명시적으로** 만들어야 한다.

---

## 5. 왜 놓쳤나 — 프로세스 관점

1. **라이브러리 기본값을 확인하지 않았다.** 원본 yml 에 적힌 값만 옮기고,
   "적혀 있지 않은 값" 은 양쪽 기본값이 같을 것이라 가정했다.
   실제로는 `sessionTimeout`(45000 vs 30000), `rebalanceTimeout`(300000 vs 60000),
   `fromBeginning`(earliest vs false) 등 여러 개가 달랐다.

2. **기능 테스트만 했고 부하 테스트를 하지 않았다.** 5건짜리 e2e 는 throttle 경로를
   아예 실행하지 않는다. throttle 은 정의상 **한계에서만 발화하는 코드**다.

3. **설정값 자체를 검증하는 테스트가 없었다.** 통합 테스트는 "메시지가 처리된다" 만 보고,
   "어떤 옵션으로 처리되는가" 는 보지 않았다.

4. **고쳤다고 보고한 것을 확인하지 않았다.** admin fail-fast 수정은 자동 치환이 조용히
   실패해(포맷터가 줄바꿈을 바꿔 패턴이 안 맞았다) 파일에 반영되지 않은 채 커밋 메시지에만 적혔다.
   다음 작업 때 파일을 직접 읽다가 발견했다.
   → 일괄 치환에는 **반드시 단언(assert)을 걸고**, 동작 주장은 **실행으로 확인**한다.

---

## 6. 재발 방지

- **회귀 테스트 추가** — `coupon-issue-request.consumer.spec.ts` 가
  `eachBatchAutoResolve: false`, `autoCommit: true`, `autoCommitThreshold: 1`,
  `partitionsConsumedConcurrently: 1`, `groupId`, `rebalanceTimeout` 을 직접 단언한다.
  통합 테스트로 드러나지 않는 항목이므로 **설정 자체를 계약으로 고정**한다.

- **기본값 대조표를 코드에 남김** — `kafka.module.ts` 상단에 Spring Kafka ↔ kafkajs
  기본값 비교표를 주석으로 유지한다. 다음에 server-b 의 consumer/producer 를 옮길 때
  같은 함정을 반복하지 않기 위함이다.

- **throttle/한계 경로는 한계 이상의 부하로 검증** — 이후 단계에서는 배치·cutoff·재시도 한도 같은
  "경계에서만 발화하는" 설정을 옮길 때 반드시 경계를 넘는 입력으로 확인한다.

- **장애 주입 확인** — "의존 컴포넌트가 없어도 뜬다" 류의 주장은 실제로 끊어 보고 확인한다
  (`KAFKA_BOOTSTRAP` 을 없는 포트로 돌려 기동/응답 확인).

---

## 7. 남겨둔 것 (의도적)

- **producer 옵션 미이관** — `linger.ms`, `batch.size`, `delivery.timeout.ms`,
  `max.in.flight.requests.per.connection`, producer 단위 `request.timeout.ms` 는
  kafkajs 에 등가가 없다. 주석으로만 남기고 사이징 단계에서 Node 기준으로 재측정한다.

- **placeholder code 충돌 가능성** — SOLD_OUT/FAILED row 의 `code` 는
  `"X" + requestId 앞 11자` 이고 `uk_user_coupon_code` UNIQUE 가 걸려 있다.
  UUID 앞 11자는 엔트로피가 낮아 대량 누적 시 충돌 가능하다. 원본에서 상속된 구조적 약점이며,
  본 과제 규모(최대 10만 행)에서는 문제가 되지 않고 **이 프로젝트가 풀려는 문제도 아니므로
  그대로 둔다** (사용자 결정, 2026-09-21).
  단, 충돌 시 poison message 가 되지 않도록 재시도 한도 + skip 은 적용되어 있다.
