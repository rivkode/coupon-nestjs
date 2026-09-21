# 캐시 전략

## 📚 문서 목록

- [Kafka](kafka.md)
- [동시성 제어](concurrency.md)
- [분산 정합성](consistency.md)
- **캐시 전략** ← 현재 문서
- [Node 런타임 제약](runtime.md)
- [부하 검증](load-test.md)

[← README](../../README.md)

---

## 한 줄 요약

이벤트 조회는 **TTL 만료 자체를 없애서** stampede 를 막는다 (갱신 60초 < TTL 300초).
매진은 negative cache 로 표시해 **진입부에서 단락**시킨다 — 매진 이후 트래픽이 시스템 자원을 쓰지 않게.

---

## 1. 캐시가 필요한 두 지점

| 지점 | 문제 | 전략 |
|---|---|---|
| 이벤트 조회 | 특정 키에 읽기가 집중 (Hot Key) | Cache-Aside + **Refresh-Ahead** |
| 매진된 쿠폰 | 매진 이후 요청이 전 구간을 헛돈다 | **Negative cache** |

---

## 2. 이벤트 조회 — TTL 만료를 없앤다

### 일반적인 Cache-Aside 의 함정

TTL 이 만료되는 순간 동시에 들어온 요청이 전부 DB 로 몰린다 (cache stampede).
락이나 probabilistic early expiration 으로 완화할 수 있지만, 더 단순한 방법이 있다.

### Refresh-Ahead — 만료 시점이 오지 않게 한다

```
TTL         300초
갱신 주기    60초   ← 항상 240초 이상 남은 상태로 유지된다
```

백그라운드 스케줄러가 60초마다 진행 중인 이벤트를 DB 에서 읽어 Redis 에 다시 쓴다.
키가 만료될 시점 자체가 오지 않으므로 stampede 위험이 **원천 차단**된다.

```ts
@Interval(60_000)
async refreshActiveEvents() {
  const events = await this.eventRepository.findByStatus(manager, 'IN_PROGRESS');
  for (const event of events) await this.cacheStore.put(toEventView(event));
}
```

### 대상을 IN_PROGRESS 로 제한하는 이유

생성 전·종료·취소 상태의 이벤트는 조회 트래픽이 없다.
전부 갱신하면 이벤트가 늘어날수록 스케줄러가 무거워진다. `status` 인덱스로 적은 비용에 스캔한다.

Cache-Aside(miss → DB → put)는 **2차 방어선**으로 남겨둔다.
새 이벤트가 IN_PROGRESS 로 전환된 직후 한 tick 정도의 짧은 윈도우만 DB 가 받는다.

### Node 에서 주의한 것

`@Interval` 은 Spring 의 `fixedDelay` 와 달리 **기동 직후 실행하지 않는다.**
그대로 두면 부팅 후 60초 동안 캐시가 비어 그 구간 요청이 전부 DB 로 간다.
`onApplicationBootstrap` 에서 1회 선행 실행한다 — 단, **await 하지 않는다**
(await 하면 포트 바인딩이 지연된다. [Node 런타임 제약](runtime.md) 참조).

---

## 3. 매진 — negative cache 로 진입부에서 단락

### 키 존재 = 매진

```
coupon:available:{eventId}:{couponTypeId}   TTL 24h
```

값은 의미가 없다. **키가 있으면 매진**이다.

- **쓰는 쪽**: C — 발급 트랜잭션 커밋 직후 재고를 fresh read 해서 0 이면 SET
- **읽는 쪽**: A — 진입부에서 EXISTS 확인, 있으면 B 호출 없이 즉시 SOLD_OUT 응답

### 차단 위치가 왜 A 인가

이 시나리오는 재고보다 요청이 훨씬 많아 **대부분의 요청이 매진 이후에 도착**한다.
가장 이른 지점에서 끊으면 그 뒤의 A→B HTTP, Redis 적재, Kafka 왕복, C 의 비관적 락을 **전부 절약**한다.

### 커밋 후에 판단하는 이유

트랜잭션 안에서 결정하면 롤백 시 실제로는 재고가 있는데 매진으로 표시되는 ghost write 가 생긴다.
또 동시에 진행 중인 다른 트랜잭션의 최종 상태를 반영하지 못한다.
커밋 후 별도 read 로 "현재 권위 상태가 0" 임을 확인한 뒤에만 적재한다.

### 매번 SET 하는 것은 의도된 동작

NX 로 최초 1회만 쓰면 TTL 만료 후 재적재가 안 돼 오히려 부정확해진다.
매진 상태에서는 A 가 단락하므로 호출 빈도 자체가 낮고,
재입고 후 들어온 요청은 fresh read 가 0 이 아니라 SET 을 호출하지 않는다 → stale 키는 24시간 안에 자연 만료.

### 안전성

캐시는 **권위가 아니다.** stale 이어도 정합성이 깨지지 않는다.

| 상황 | 결과 |
|---|---|
| SET 직전에 통과한 요청 | 정상 흐름으로 진입 → C 가 SOLD_OUT 처리. 사용자에게는 같은 결과 |
| cache miss / Redis 장애 | fall-through → 정상 흐름. degrade 하지 않는다 |
| 관리자 재입고 | stale 키가 남으므로 운영 시 수동 삭제 필요 |

---

## 4. 캐시 실패는 전부 삼킨다

```ts
try {
  await this.redis.set(key, json, 'EX', ttl);
} catch (e) {
  this.logger.warn(`failed to cache: ... reason=${String(e)}`);   // 삼킨다
}
```

권위는 MySQL 이고 DB fallback 이 항상 존재한다.
Redis 일시 장애가 API 실패로 이어지면 안 된다.

> **예외**: server-b 의 Redis 는 DB fallback 이 없다 (유일한 저장소).
> 그래도 재시도로 이벤트 루프를 붙잡으면 접수 응답 지연이 무너지므로 빨리 실패시키고,
> 회복은 보완 스케줄러에 맡긴다.

---

## 5. 정리

| 항목 | 결론 |
|---|---|
| stampede | 락이 아니라 **갱신 주기 < TTL** 로 만료 자체를 없앤다 |
| 갱신 대상 | IN_PROGRESS 만. 조회가 없는 상태는 자연 만료 |
| 매진 | negative cache 로 **가장 이른 지점**에서 단락 |
| 적재 시점 | 커밋 후 fresh read — ghost write 방지 |
| 실패 | 전부 삼킨다. 캐시는 권위가 아니다 |
