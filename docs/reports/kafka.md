# Kafka — kafkajs 운영 보고서

## 📚 문서 목록

- **Kafka** ← 현재 문서
- [동시성 제어](concurrency.md)
- [분산 정합성](consistency.md)
- [캐시 전략](cache.md)
- [Node 런타임 제약](runtime.md)

[← README](../../README.md)

---

## 한 줄 요약

Spring Kafka 에서 한 줄이던 설정이 kafkajs 에는 **없거나 기본값이 반대**다.
그대로 옮겼더니 부하에서 **메시지가 사라지고** 오프셋이 **한 번도 커밋되지 않았다.**
세 옵션을 맞물려 설정해 해결했고, 설정 자체를 회귀 테스트로 고정했다.

---

## 1. 무엇을 만들려 했나

발급 처리는 1 vCPU MySQL 이 비관적 락으로 소화할 수 있는 만큼만 흘려보내야 한다.
Spring 에서는 세 줄이면 끝난다.

```yaml
consumer:
  max-poll-records: 10       # 한 번에 10건만 가져온다
  enable-auto-commit: false
listener:
  ack-mode: RECORD           # 레코드 1건 처리마다 커밋
  concurrency: 1
```

kafkajs 에는 **`max.poll.records` 에 해당하는 옵션이 없다.** 배치는 레코드 수가 아니라
바이트(`maxBytesPerPartition`, 기본 1MB) 기준으로 잡힌다.
그래서 배치를 받아 루프 안에서 10건만 처리하고 빠져나오는 방식을 택했다.

---

## 2. 사고 ① — throttle 로 남긴 메시지가 사라졌다

### 무슨 일이 일어났나

배치가 10건을 넘으면 **11번째 이후 레코드가 처리되지 않은 채 유실됐다.**
`user_coupon` 도, outbox 도, 결과 이벤트도 생기지 않는다.
사용자 입장에서는 발급 요청이 영원히 대기 상태다.

### 원인

`eachBatchAutoResolve` 의 기본값이 `true` 다. `eachBatch` 콜백이 **예외 없이 반환하면**
kafkajs 는 배치의 마지막 오프셋을 통째로 "처리 완료"로 표시한다.

```js
// kafkajs/src/consumer/runner.js:336
if (this.eachBatchAutoResolve) {
  this.consumerGroup.resolveOffset({ topic, partition, offset: batch.lastOffset() })
}
```

우리는 throttle 때문에 10건만 처리하고 `break` 했는데, kafkajs 입장에서는 정상 종료다.

> **방향이 반대다.** Spring 은 poll 단위 자체를 10으로 제한해서 11번째 레코드가 애초에 전달되지 않는다.
> kafkajs 는 배치를 먼저 주고 소비자가 알아서 처리하게 하므로, **"남겨둔 것"을 명시하지 않으면
> "처리한 것"으로 간주**한다.

### 해결

```ts
eachBatchAutoResolve: false,   // 명시적으로 resolve 한 레코드만 전진
```

### 확인

150건을 한 번에 produce 해 배치가 10건을 크게 넘게 만들었다.

| | 수정 전 | 수정 후 |
|---|---|---|
| `user_coupon` | 일부만 생성 | **150 / 150** |
| outbox PUBLISHED | 일부만 | **150** |
| 재고 (200 시작) | — | **50** (정확히 150 차감) |

---

## 3. 사고 ② — 오프셋이 한 번도 커밋되지 않았다

### 무슨 일이 일어났나

컨슈머 그룹 오프셋이 영원히 `0` 이다. 메시지는 처리되지만:

- 재시작·리밸런스마다 토픽을 **처음부터 재처리**한다.
  중복 발급은 UNIQUE 가 막아주지만, **재처리 경로에서는 outbox 가 생기지 않아 결과가 전달되지 않는다.**
- `consumer lag` 지표가 무의미해진다 (항상 전체 메시지 수).

### 원인

`autoCommit: false` 로 두면 `autoCommitInterval` 과 `autoCommitThreshold` 가 **둘 다 `null`** 이 된다.
그런데 인자 없는 `commitOffsetsIfNecessary()` 는 그 둘을 보고 커밋 여부를 정한다.

```js
// kafkajs/src/consumer/offsetManager/index.js:200
const timeoutReached   = this.autoCommitInterval  != null && ...
const thresholdReached = this.autoCommitThreshold != null && ...
if (timeoutReached || thresholdReached) { return this.commitOffsets() }
```

둘 다 `null` → **영구 no-op**. 다른 커밋 경로에도 `if (this.autoCommit)` 가드가 있어
`autoCommit: false` 이면 **커밋 경로가 전부 닫힌다.**

> **같은 이름인데 뜻이 정반대다.**
> Spring 의 `enable-auto-commit: false` = "자동 커밋을 끄고 컨테이너가 ack-mode 에 따라 직접 커밋한다".
> kafkajs 의 `autoCommit: false` = "**커밋을 아예 하지 않는다**".

### 해결

`ack-mode: RECORD` 를 만들려면 오히려 autoCommit 을 **켜고** 임계값을 1로 둔다.

```ts
autoCommit: true,
autoCommitThreshold: 1,   // resolve 된 레코드 1건마다 커밋
```

### 확인

```
GROUP                 TOPIC                PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
coupon-issue-server-c coupon-issue-request 0          52              52              0
coupon-issue-server-c coupon-issue-request 1          47              47              0
coupon-issue-server-c coupon-issue-request 2          51              51              0
```

합계 150 = 처리한 메시지 수, LAG 0. **재기동 후 재처리 0건.**

---

## 4. 사고 ③ — publish timeout 이 걸리지 않았다

### 무슨 일이 일어났나

보완 스케줄러는 `fixed-delay 1초`로 batch 50 을 돈다. 건당 전송이 오래 끌면 cycle 이 폭주하므로
스케줄러 전용으로 **500ms** 짧은 timeout 을 둔다. 그런데 이 가드가 실제로는 동작하지 않았다.

### 원인

```ts
producer.send({ ..., timeout: 500 })   // ← 이건 상한이 아니다
```

kafkajs 의 `timeout` 은 Produce 요청에 실려 나가는 **브로커의 ack 대기값**이다.
로컬 재시도(`retry.retries: 5`)나 미연결 상태의 `connect()` 대기는 전혀 끊지 못한다.
원본 Java 는 `future.get(500, MILLISECONDS)` 로 **호출 스레드**를 하드 바운드했었다.

### 해결

`Future.get(timeout)` 에 해당하는 래퍼를 만들어 호출 대기를 직접 제한했다.

```ts
await withTimeout(
  this.sendInternal(payload, timeoutMs),
  timeoutMs,
  `kafka send timed out after ${timeoutMs}ms`,
);
```

---

## 5. 사고 ④ — consumer 기동 실패가 영구적이었다

토픽 생성과 consumer 구독 사이에 레이스가 있어 `This server does not host this topic-partition` 로
기동에 실패했는데, 당시 코드가 로그만 남기고 끝냈다. 결과는
**"앱은 떠 있는데 메시지를 영원히 소비하지 않는"** 상태다.

Spring 의 리스너 컨테이너는 브로커·토픽이 준비될 때까지 백그라운드에서 무한 재시도한다.
지수 backoff(1초 → 30초) 재시도 루프를 넣어 같은 동작으로 맞췄다.

**확인** — 토픽이 없는 상태에서 기동: 1회 실패 후 1초 뒤 재시도로 연결, HTTP 는 1.1초 만에 응답.

---

## 6. 설정 대조표

kafkajs 열은 `node_modules/kafkajs/src` 소스로 확인한 값이다 (v2.2.x).
Java 열은 Boot 3.5 가 관리하는 kafka-clients 3.x 기준.

### Consumer

| 설정 | Java 기본 | 적용값 | kafkajs | 조치 |
|---|---|---|---|---|
| `max.poll.records` | 500 | 10 (c) / 50 (b) | **등가 없음** (바이트 기준) | 루프에서 직접 제한 + `eachBatchAutoResolve: false` |
| `enable.auto.commit` | true | false | `autoCommit: false` 면 커밋 경로가 전부 닫힘 | `autoCommit: true` + `autoCommitThreshold: 1` |
| `ack-mode` (Spring) | BATCH | RECORD | 등가 없음 | 레코드마다 `resolveOffset` → 커밋 |
| `auto.offset.reset` | latest | earliest | `fromBeginning` 기본 **false** | `true` 명시 |
| `session.timeout.ms` | 45000 | 45000 | 기본 **30000** | 45000 명시 |
| `max.poll.interval.ms` | 300000 | 300000 | `rebalanceTimeout` 기본 **60000** | 300000 명시 |
| `isolation.level` | read_uncommitted | read_committed | 기본 **READ_COMMITTED** | 그대로 (우연히 일치) |
| `concurrency` (Spring) | 1 | 1 | `partitionsConsumedConcurrently` | 1 |

### Producer

| 설정 | Java 기본 | 적용값 | kafkajs | 조치 |
|---|---|---|---|---|
| `acks` | all | all | `send({acks})` 기본 -1(=all) | 그대로 |
| `enable.idempotence` | true | true | `idempotent` 기본 **false** | `true` 명시 |
| `retries` | MAX_VALUE | 5 | idempotent 시 MAX_SAFE_INTEGER | 5 명시 (EoS 경고 발생) |
| `request.timeout.ms` | 30000 | 5000 | client 단위 30000 | **미이관** |
| `delivery.timeout.ms` | 120000 | 30000 | 등가 없음 | **미이관** |
| `linger.ms` / `batch.size` | 0 / 16384 | 5 / 32768 | 등가 없음 | **미이관** |
| `max.in.flight...` | 5 | 5 | 기본 **무제한** | **미이관** |
| `compression.type` | none | lz4 (b) | GZIP 만 구현, LZ4 는 `KafkaJSNotImplemented` | **미이관** |

### 기타

| 설정 | 적용값 | 조치 |
|---|---|---|
| `admin.fail-fast` | false | `createTopics` 실패를 catch + warn, 비차단 실행 |
| `admin.operation-timeout` | 5s | **미이관** — 대신 admin 을 await 하지 않음 |

미이관 항목은 처리량·지연 특성에 영향을 주므로 **부하 검증 단계에서 Node 기준으로 재측정**한다.

---

## 7. 왜 기능 테스트로는 안 잡혔나

세 사고 모두 **경계에서만 발화**한다.

| 사고 | 발화 조건 |
|---|---|
| 메시지 유실 | 배치 > `max-poll-records` — 초기 테스트는 5건이라 throttle 자체가 안 돌았다 |
| 오프셋 미커밋 | 재시작·리밸런스 — 기능만 보면 정상으로 보인다 |
| publish timeout | 브로커가 느릴 때 |
| 기동 실패 | 토픽이 없는 상태에서 기동 |

그래서 **설정 자체를 단언하는 회귀 테스트**를 두었다.
통합 테스트는 "메시지가 처리된다"만 보고 "어떤 옵션으로 처리되는가"는 보지 않는다.

```ts
expect(runOptions.eachBatchAutoResolve).toBe(false);
expect(runOptions.autoCommit).toBe(true);
expect(runOptions.autoCommitThreshold).toBe(1);
```

---

## 8. 정리

| 교훈 | 내용 |
|---|---|
| 기본값을 먼저 확인한다 | 설정 파일에 **안 적혀 있던 값**이 가장 위험하다. 양쪽 기본값이 같을 것이라 가정하면 안 된다 |
| 이름이 같아도 뜻이 다르다 | `enable.auto.commit: false` ↔ `autoCommit: false` 는 결과가 정반대다 |
| 한계 경로는 한계 이상으로 검증한다 | throttle·batch·재시도 한도는 정의상 경계에서만 동작한다 |
| 장애를 주입해 확인한다 | "브로커 없어도 뜬다"는 실제로 끊어 보기 전까지는 추측이다 |
