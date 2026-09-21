# 분산 정합성

## 📚 문서 목록

- [Kafka](kafka.md)
- [동시성 제어](concurrency.md)
- **분산 정합성** ← 현재 문서
- [캐시 전략](cache.md)
- [Node 런타임 제약](runtime.md)
- [부하 검증](load-test.md)

[← README](../../README.md)

---

## 한 줄 요약

Redis 에 신청이 적재된 순간부터 **at-least-once** 가 보장된다.
결과는 Outbox 로 안전하게 발행하고, `(user_id, coupon_type_id)` UNIQUE 가 1인 1장을 강제한다.
메시지가 유실되어도 보완 스케줄러가 **30초 안에 SUCCESS 또는 FAILED 로 결론**을 낸다.

---

## 1. 세 서비스에 걸친 흐름

```
사용자 → A ──sync HTTP──▶ B ──Kafka(issue)──▶ C
                          │  ▲                 │
                       [Redis] │ Kafka(result)  │
                       신청 적재 └───── Outbox ◀─┘
```

A→B 는 동기지만 B 는 **적재 후 즉시 "접수 완료"** 를 응답한다.
실제 발급(재고 락)은 C 에서 비동기로 일어난다. 사용자 응답 지연과 락 경합을 분리하는 것이 핵심이다.

---

## 2. 멱등성 — UNIQUE 가 권위

```sql
CONSTRAINT uk_user_coupon_user_type UNIQUE (user_id, coupon_type_id)
```

이 제약 하나가 "1인 1장"과 "Kafka 중복 메시지 차단"을 동시에 해결한다.
Idempotency-Key 헤더를 따로 두지 않는 이유다.

Redis 의 중복 체크(`HSETNX`)는 **비용 절감용 1차 방어선**이지 권위가 아니다.
`HSETNX → HSET → ZADD` 가 원자적이지 않아도 되는 이유가 여기 있다.

### 중복 INSERT 를 만났을 때

TypeORM 의 `insert()` 는 즉시 실행되므로, 제약 위반을 **트랜잭션 안에서 잡고 early-return 하면
차감된 재고만 커밋되고 쿠폰은 없는 누수**가 생긴다.
그래서 예외를 트랜잭션 **밖까지 올려 롤백**시킨 뒤 멱등 종료한다.

또한 두 UNIQUE 를 구분한다.

| 위반 | 의미 | 처리 |
|---|---|---|
| `uk_user_coupon_user_type` | 이미 발급받았다 | 멱등 종료 |
| `uk_user_coupon_code` | 코드 충돌 — 전혀 다른 사고 | 그대로 올려 드러낸다 |

구분하지 않으면 코드 충돌까지 "이미 발급됨"으로 오인해 조용히 삼킨다.

---

## 3. Outbox — 결과를 안전하게 발행한다

발급 트랜잭션 안에서 결과를 테이블에 함께 INSERT 하고, **발행은 트랜잭션 밖**에서 한다.

```
[트랜잭션]  중복 체크 → 이벤트 유효성 → 재고 비관락 차감
            → user_coupon INSERT → outbox_event INSERT → COMMIT

[트랜잭션 밖]  poller(500ms) → Kafka 발행 → 성공분만 PUBLISHED 로 bulk update
```

poller 에 트랜잭션을 걸지 않는 이유: 걸면 batch 크기만큼의 Kafka 왕복이 DB 트랜잭션 안에 들어가
커넥션을 발행 시간 내내 점유한다. 같은 DB 에서 발급 처리가 재고 행에 락을 잡고 있으므로 그대로 경합이 된다.

상태 갱신 전에 죽으면 같은 결과가 다시 발행되지만(at-least-once), 수신 측의 Redis 갱신이 멱등이라 안전하다.

---

## 4. 30초 SLA — 보완 스케줄러

Redis 적재와 Kafka 발행은 원자적이지 않다. 발행 자체가 유실되는 경우가 있다.
"Redis 에 PENDING 이 있다 = 처리 의도가 커밋됐다"를 진실로 보고 회복한다.

스케줄러(1초 주기)가 cutoff(10초) 초과 PENDING 을 찾아 **이 순서로** 처리한다.

| 단계 | 조건 | 동작 |
|---|---|---|
| ① | C 에 결과가 있다 | Redis 에 동기화하고 종결 (메시지만 유실된 경우) |
| ② | C 가 모르고 `attempts < 3` | Kafka **재발행** + 카운터 증가 |
| ③ | `attempts >= 3` | FAILED 로 마감 |

### 카운터를 발행 "직전"에 올리는 이유

발행이 영구적으로 실패해도 cap 이 수렴해야 한다.
발행 성공 후에 올리면 영원히 재시도하게 된다.

```
cutoff 10초 × max 3회 = 30초 안에 반드시 결론
```

### 검증

| 시나리오 | 결과 |
|---|---|
| 메시지 유실 → 재발행 | attempts 1→2, 재발행 후 **SUCCESS 회복** |
| C 가 처리 불가 (cap 소진) | 1→2→3 → **FAILED, 23초** |
| 카운터 | `pending_scheduler_republish 3`, `pending_scheduler_give_up 1` |

카운터는 `/actuator/prometheus` 로 노출된다. `give_up` 이 올라가면 SLA 안에서 결론은 냈지만
발급에 실패한 건이 있다는 뜻이다.

### 전제

**단일 server-b 인스턴스**를 가정한다. 다중 인스턴스에서는 `ZRANGEBYSCORE` 가 같은 항목을
동시에 잡을 수 있어 cap 의 의미가 약해진다 (정합성 자체는 C 의 UNIQUE 가 보호한다).

---

## 5. 접수 단계의 발행 실패는 삼킨다

```ts
try {
  await this.publisher.publish(payload);
} catch (e) {
  // Redis 에 attempts=1 로 적재됨 → 10초 후 스케줄러가 재발행. cap 안에서 회복된다.
  this.logger.warn('initial publish failed — scheduler will retry within SLA');
}
return IssueAcceptance.accepted(requestId);   // 항상 ACCEPTED
```

사용자에게 5xx 를 돌려주면 "재시도했더니 DUPLICATE" 라는 모호한 UX 가 생긴다.
응답 모델이 애초에 "접수 완료 → 결과는 조회"이므로, 회복은 전적으로 스케줄러에 맡긴다.

---

## 6. 잘못된 메시지는 토픽에 넣지 않는다

payload 검증을 발행 직전에 수행한다. 검증에 실패하면 발행하지 않고 예외를 올리며,
접수 서비스가 그것을 삼켜 종결한다.

검증을 빼먹으면 `userId: 0` 같은 메시지가 그대로 토픽에 실려 C 까지 흘러간다.
**확인** — `X-User-Id: 0` 요청 시 접수는 200 으로 응답하되 발행은 차단되고, C 는 잘못된 메시지를 0건 관측한다.

---

## 7. 정리

| 보장 | 근거 |
|---|---|
| 1인 1장 | `(user_id, coupon_type_id)` UNIQUE |
| 중복 메시지 무해 | 같은 UNIQUE + 처리 전 존재 체크 |
| 결과 전달 | Outbox + at-least-once. 수신 측 멱등 |
| 유실 회복 | 보완 스케줄러, cutoff × cap = 30초 결론 |
| 재고 누수 방지 | 제약 위반 시 트랜잭션 밖으로 올려 **롤백** |
