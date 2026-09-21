# 동시성 제어

## 📚 문서 목록

- [Kafka](kafka.md)
- **동시성 제어** ← 현재 문서
- [분산 정합성](consistency.md)
- [캐시 전략](cache.md)
- [Node 런타임 제약](runtime.md)

[← README](../../README.md)

---

## 한 줄 요약

재고 차감은 `SELECT ... FOR UPDATE` 로 직렬화한다.
쿠폰 사용은 낙관적 락인데, **TypeORM 의 `@VersionColumn` 은 낙관적 락으로 동작하지 않아**
조건부 UPDATE 로 직접 구현했다.

---

## 1. 동시성 지점은 두 곳이다

| 지점 | 트래픽 | 방식 | 이유 |
|---|---|---|---|
| 재고 차감 (발급) | 매진까지 폭주 | **비관적 락** | 한 row 에 경합이 몰린다. 낙관적 락이면 재시도 폭풍이 난다 |
| 쿠폰 사용 (redeem) | 드묾 | **낙관적 락** | 한 쿠폰을 동시에 쓰려는 시도는 거의 없다. 락 오버헤드가 아깝다 |

발급은 Kafka consumer 안에서 처리되므로 **사용자 응답 경로와 락 경합이 분리**된다.
사용자는 "접수 완료"를 즉시 받고, 락 대기는 consumer 쪽에서만 일어난다.

---

## 2. 재고 — 비관적 락

`coupon_type_inventory` 의 row 하나가 재고의 권위다. Redis 는 캐시일 뿐이다.

```ts
const inventory = await em
  .createQueryBuilder(CouponTypeInventoryOrmEntity, 'i')
  .setLock('pessimistic_write')
  .where('i.event_id = :eventId AND i.coupon_type_id = :couponTypeId', { ... })
  .getOne();
```

실제 발행되는 SQL:

```sql
SELECT ... FROM coupon_type_inventory i
WHERE i.event_id = ? AND i.coupon_type_id = ?
FOR UPDATE
```

### 주의: 트랜잭션 매니저에서 시작해야 한다

```ts
// ❌ 락이 걸리지 않는다 — 다른 커넥션이다
dataSource.getRepository(X).createQueryBuilder(...).setLock('pessimistic_write')

// ✅ 트랜잭션 콜백의 EntityManager 에서 시작
dataSource.transaction(async (em) => {
  em.createQueryBuilder(X, 'i').setLock('pessimistic_write')...
})
```

`findOne({ lock: ... })` 도 되지만 조인이 붙으면 MySQL 이 거부하므로 QueryBuilder 를 표준으로 삼았다.

### 검증

재고 3에 동시 요청 10건:

| 항목 | 결과 |
|---|---|
| 성공 | **정확히 3건** |
| 최종 재고 | **0** (음수 없음) |

락이 없으면 이 지점이 깨진다. 통합 테스트로 고정했다.

---

## 3. 쿠폰 사용 — 낙관적 락

### 문제: `@VersionColumn` 이 동작하지 않는다

TypeORM 의 `@VersionColumn` 은 UPDATE 시 `version = version + 1` 을 **SET 만** 하고
`WHERE version = ?` 가드를 넣지 않는다. `OptimisticLockVersionMismatchError` 는
**읽기 시점**(`SelectQueryBuilder`)에서만 던져진다.

즉 `@VersionColumn` + `save()` 조합은 **동시 사용을 막지 못한다.**
컴파일도 되고 기능 테스트도 통과하는데, 동시 요청 두 건이 **둘 다 성공**한다.

### 해결: 조건부 UPDATE + `affected` 판정

```ts
const result = await em.createQueryBuilder()
  .update(UserCouponOrmEntity)
  .set({ status: 'USED', usedAt: now, version: () => 'version + 1' })
  .where('user_coupon_id = :id AND version = :expectedVersion', { id, expectedVersion })
  .execute();

if (result.affected === 0) {
  throw new OptimisticLockFailureError(...);   // → 409 RACE_RETRY
}
```

실제 발행되는 SQL:

```sql
UPDATE user_coupon
SET status = ?, used_at = ?, version = version + 1
WHERE user_coupon_id = ? AND version = ?
```

`version` 컬럼은 스키마에 그대로 두되, **`@VersionColumn` 이 아니라 평범한 `@Column`** 으로 매핑한다.
TypeORM 이 몰래 증가시키는 것을 막기 위해서다.

### 처리 순서

1. `code` 로 조회 → 없으면 404
2. 소유권 검증 → 다른 사용자면 **404 로 마스킹** (존재 여부를 흘리지 않는다)
3. 이미 사용됨 → 같은 사용자의 재호출은 **멱등 200**, 최초 사용 시각을 그대로 반환
4. 조건부 UPDATE → `affected === 0` 이면 409 `RACE_RETRY`

### 검증

| 테스트 | 결과 |
|---|---|
| 같은 version 으로 두 번 시도 | 첫 번째 `affected=1`, 두 번째 **`affected=0`** |
| 동시 20건 | 실제 전이 **1회**, version 정확히 1 |
| API 동시 20건 | 중복 사용 0건 |

---

## 4. 트랜잭션 경계

NestJS 에는 `@Transactional` 이 없다. AsyncLocalStorage 기반 라이브러리를 쓰지 않고
**명시적 경계**를 택했다.

```ts
await this.dataSource.transaction(async (tx) => {
  // 이 안의 모든 DB 접근은 tx 를 통한다
});
```

- 리포지토리 메서드는 첫 인자로 트랜잭션 컨텍스트를 받는다
- 경계는 **`application/` 계층에만** 존재한다 (현재 2곳: 발급 처리, 쿠폰 사용)
- 트랜잭션 안에서 HTTP·Kafka·Redis 를 호출하지 않는다

### `afterCommit` 대응

Spring 의 `TransactionSynchronization.afterCommit` 은 등가물이 없다.
`await dataSource.transaction(...)` **이후 줄**에서 실행한다.

```ts
let checkAvailability = false;
await this.dataSource.transaction(async (tx) => {
  /* ... */
  checkAvailability = true;
});
// 커밋 이후 — 롤백되면 플래그가 서지 않아 ghost write 가 없다
if (checkAvailability) await this.markSoldOutIfDepleted(...);
```

---

## 5. 정리

| 항목 | 결론 |
|---|---|
| 재고 | 비관적 락. 트랜잭션 EntityManager 에서 시작해야 실제로 `FOR UPDATE` 가 나간다 |
| 쿠폰 사용 | `@VersionColumn` 을 믿지 말 것. 조건부 UPDATE + `affected` 로 직접 판정 |
| 트랜잭션 | 명시적 경계, application 계층에만. 외부 호출은 경계 밖으로 |
| 검증 | 동시성은 단위 테스트로 증명되지 않는다. 실제 MySQL 의 행 락이 필요하다 |
