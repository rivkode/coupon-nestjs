---
name: typeorm-patterns
description: 본 프로젝트의 TypeORM 1.x 표준 패턴과 검증된 함정 모음. 명시적 dataSource.transaction() 경계(ADR-N01), 비관적 락 setLock('pessimistic_write')(ADR-003), 낙관적 락은 조건부 UPDATE + affected 검사(ADR-N03 — @VersionColumn 단독은 JPA 와 동작이 다름), afterCommit 대체, 멀티 DataSource(Database per Service), Flyway SQL 을 그대로 옮기는 마이그레이션(ADR-N05), BIGINT→string / DATETIME(3) / VARCHAR enum / UNIQUE 위반 감지 같은 mysql2 함정을 다룬다. 엔티티·리포지토리·트랜잭션·락·마이그레이션·DataSource 설정을 건드릴 때 PROACTIVELY 사용한다.
---

# TypeORM Patterns & 함정

설치 버전: `typeorm@1.1.x` + `mysql2`. 아래 내용은 **node_modules 소스로 검증된 것**만 적는다.

---

## 1. 트랜잭션 — 명시적 경계 (ADR-N01)

데코레이터(`@Transactional()`) 를 쓰지 않는다. 애플리케이션 서비스가 경계를 연다.

```ts
await this.dataSource.transaction(async (em) => {
  // 이 안의 모든 DB 접근은 반드시 em 을 통해야 한다.
});
```

**규칙**
- 콜백 안에서 `this.repository.xxx()` (DataSource 기본 리포지토리) 를 쓰면 **다른 커넥션**이다 → 락이 안 걸린다.
- 리포지토리 메서드는 첫 인자로 `em` 을 받는다.
- 콜백 안에 **HTTP/Kafka/Redis 호출을 넣지 않는다** (원본 §10 안티패턴).

**`afterCommit` 대체** — Spring 의 `TransactionSynchronization.afterCommit` 은 등가물이 없다.

```ts
let soldOutCandidate: { eventId: bigint; couponTypeId: bigint } | null = null;
await this.dataSource.transaction(async (em) => {
  /* ... */
  soldOutCandidate = { eventId, couponTypeId };
});
// 커밋 이후. 실패해도 삼킨다 (캐시는 권위가 아니다 — ADR-011).
if (soldOutCandidate) {
  try { await this.markSoldOutIfDepleted(soldOutCandidate); }
  catch (e) { this.logger.warn(`availability post-check failed: ${String(e)}`); }
}
```

---

## 2. 비관적 락 (ADR-003) — 재고 차감

```ts
const inventory = await em.getRepository(CouponTypeInventoryOrmEntity)
  .createQueryBuilder('i')
  .setLock('pessimistic_write')               // → SELECT ... FOR UPDATE
  .where('i.event_id = :eventId AND i.coupon_type_id = :couponTypeId', { eventId, couponTypeId })
  .getOne();
```

- **반드시 `em`(트랜잭션 EntityManager) 에서 시작**해야 한다. `dataSource.getRepository()` 로 하면 락이 걸리지 않는다.
- `findOne({ lock: { mode: 'pessimistic_write' } })` 도 가능하지만, 조인이 붙으면 MySQL 이 거부할 수 있어
  QueryBuilder 형태를 표준으로 삼는다.
- 락을 잡은 뒤 재고 감소는 도메인 모델(`CouponTypeInventory.decrement()`)이 판단하고, 결과를 `em.save()` 한다.

---

## 3. 낙관적 락 (ADR-007 / ADR-N03) — ⚠️ JPA 와 다르다

**검증된 사실**: TypeORM 의 `UpdateQueryBuilder` 는 `@VersionColumn` 에 대해 `version = version + 1` 을
SET 만 하고 **`WHERE version = N` 가드를 넣지 않는다**. `OptimisticLockVersionMismatchError` 는
`SelectQueryBuilder`(읽기 시점)에서만 던져진다.
→ `@VersionColumn` + `save()` 조합은 **동시 redeem 을 막지 못한다.**

**표준 구현**:

```ts
const res = await em.createQueryBuilder()
  .update(UserCouponOrmEntity)
  .set({ status: 'USED', usedAt: now, version: () => 'version + 1' })
  .where('user_coupon_id = :id AND version = :version', { id: uc.id, version: uc.version })
  .execute();

if (res.affected === 0) {
  throw new RaceRetryException();   // → 409 RACE_RETRY
}
```

- `version` 컬럼은 스키마 parity 를 위해 유지하되 `@VersionColumn` 대신 **평범한 `@Column`** 으로 매핑한다
  (TypeORM 이 몰래 증가시키는 것을 막기 위해).
- redeem 의 순서는 원본 `RedeemCouponService` 를 그대로: 조회 → 소유권(404 마스킹) → 이미 USED 면 멱등 200 → 조건부 UPDATE.

---

## 4. 멀티 DataSource (ADR-006)

`server-a` → `server_a`, `server-c` → `server_c`. **같은 앱에 두 DB 를 물리지 않는다** (각 앱이 하나씩).
`server-b` 는 DataSource 가 없다 (Redis only).

```ts
TypeOrmModule.forRootAsync({
  useFactory: (cfg: ConfigService) => ({
    type: 'mysql',
    host: cfg.get('DB_HOST', 'localhost'),
    port: cfg.get<number>('DB_PORT', 3306),
    database: 'server_a',
    entities: [/* 명시적으로 나열 — glob 금지 */],
    migrations: [/* ... */],
    migrationsRun: true,          // Flyway 의 baseline-on-migrate:false 에 대응
    synchronize: false,           // ❌ 영구 금지 (ADR-N05)
    timezone: 'Z',                // jdbc.time_zone: UTC 대응
    extra: { connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10) },  // HikariCP pool=10
    logging: ['error', 'warn'],
  }),
})
```

- pool 크기 기본 10 — 원본 측정 결과(`docs/reports/infra-sizing.md §7`)에서 나온 값. 임의로 올리지 말 것.
- `entities` 는 glob 대신 **배열로 명시** (모노레포에서 glob 은 다른 앱 엔티티를 빨아들인다).

---

## 5. 마이그레이션 (ADR-N05)

원본 Flyway SQL 을 `queryRunner.query()` 안에 **문자열 그대로** 넣는다. TypeORM 이 DDL 을 생성하게 두지 않는다.

```ts
export class Schema1700000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE issue_request ( ... )`);   // V1__schema.sql 원문
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE issue_request`);
  }
}
```

- 파일당 원본 Flyway 파일 하나에 대응시킨다 (`V1` → `...Schema`, `V2` → `...AddEventStatus`).
- `typeorm migration:generate` 를 쓰지 않는다 (엔티티 기준 DDL 을 만들어 이름이 달라진다).
- 스키마가 정말 맞는지는 `SHOW CREATE TABLE` 결과를 원본 MySQL 과 diff 해서 확인한다.

---

## 6. mysql2 / TypeORM 함정 — 전부 실제로 물린 적 있는 것들

### 6.1 BIGINT 는 string 으로 온다 ⚠️ 최우선
`user_id`, `event_id`, `coupon_type_id` 전부 `BIGINT`. TypeORM/mysql2 는 `bigint` 컬럼을 **string** 으로 반환한다.

```ts
// ❌ 원본의 소유권 검증(404 마스킹)이 조용히 깨진다
if (uc.userId !== command.userId) throw new CouponNotFoundError(...);
//    "123456"  !==  123456   → 항상 true → 모든 redeem 이 404
```

**본 프로젝트의 규칙 — 계층별로 표현이 정해져 있다:**

| 계층 | ID 표현 | 근거 |
|---|---|---|
| wire (HTTP JSON / Kafka payload) | **`number`** | Java `long` 의 JSON 직렬화 결과. string 으로 실으면 계약이 깨진다 (api-contract §9) |
| 도메인 모델 / 애플리케이션 | **`number`** | 비교·산술이 자연스럽고 wire 와 같아 변환 지점이 하나로 준다 |
| ORM 엔티티 (DB 경계) | **`string`** | mysql2 가 그렇게 준다. 바꾸지 않는다 |

→ **변환은 매퍼(=ORM 경계) 한 곳에서만** 한다. `Number(row.userId)` 로 올리고, 쓸 때는 그대로 넘긴다.
→ 도메인/애플리케이션 코드에서는 `===` 비교가 안전하다. 매퍼를 건너뛰고 ORM 엔티티를 직접 비교하지 말 것.
→ 읽기 전용 경로(§ nest-ddd-layering §3)는 ORM 엔티티를 그대로 쓰므로, **응답 DTO 로 내보낼 때 `Number()` 를 반드시 태운다**.

> 안전 범위: `user_id` 는 헤더에서, 나머지는 AUTO_INCREMENT 에서 온다. 모두 2^53 아래라
> `number` 로 충분하다 (Java 도 `long` 을 그대로 JSON number 로 내보내고 있었다).
> `Number.isSafeInteger()` 로 경계에서 한 번 막아두면 회귀를 잡을 수 있다.

### 6.2 enum 컬럼
스키마는 `VARCHAR(20)`. TypeORM `type: 'enum'` 은 MySQL `ENUM` 을 만들어 **원본과 달라진다**.

```ts
@Column({ type: 'varchar', length: 20 })
status!: UserCouponStatus;   // TS union: 'SUCCESS' | 'SOLD_OUT' | 'FAILED' | 'USED'
```

### 6.3 DATETIME(3) + UTC
```ts
@Column({ type: 'datetime', precision: 3, name: 'issued_at' })
issuedAt!: Date;
```
DataSource 에 `timezone: 'Z'` 필수. Java 는 `jdbc.time_zone: UTC` 로 동일하게 맞춰져 있다.

`created_at` / `updated_at` 은 DB DEFAULT 가 채운다 → `insert: false, update: false` 로 두고 앱에서 쓰지 않는다
(원본 JPA 의 `insertable=false, updatable=false` 와 동일).

### 6.4 UNIQUE 위반 감지 (ADR-004 멱등성)
Spring 의 `DataIntegrityViolationException` 대응:

```ts
catch (e) {
  if (e instanceof QueryFailedError && (e.driverError as any)?.errno === 1062) {
    // 중복 — 멱등 처리 (early return)
    return;
  }
  throw e;
}
```
`ER_DUP_ENTRY = 1062`. 메시지 문자열 매칭 대신 errno 로 판단한다.

### 6.5 `save()` 는 SELECT 를 먼저 한다
`repository.save(entity)` 는 id 가 있으면 존재 확인 쿼리를 돌린다. 핫 경로(발급 트랜잭션)에서는
`em.insert()` / `createQueryBuilder().update()` 를 써서 왕복을 줄인다.

### 6.6 `em.getRepository()` vs `dataSource.getRepository()`
트랜잭션 안에서는 **반드시 `em.getRepository()`**. 혼동하면 락·롤백이 전부 무효가 된다.

### 6.7 `bigint` PK 와 `@PrimaryGeneratedColumn`
```ts
@PrimaryGeneratedColumn({ type: 'bigint', name: 'user_coupon_id' })
id!: string;   // string 으로 받는다 (§6.1)
```

---

## 7. 체크리스트

- [ ] 트랜잭션 콜백 안의 모든 DB 접근이 `em` 을 통하는가
- [ ] 트랜잭션 안에 외부 호출(HTTP/Kafka/Redis)이 없는가
- [ ] 비관적 락이 `em` 에서 시작한 QueryBuilder 인가
- [ ] 낙관적 락이 조건부 UPDATE + `affected === 0` 검사인가 (`@VersionColumn` 미사용)
- [ ] `synchronize: false` 인가
- [ ] 마이그레이션이 원본 SQL 원문인가 (generate 미사용)
- [ ] BIGINT 비교 전 정규화했는가
- [ ] 상태 컬럼이 `varchar(20)` 인가 (`enum` 아님)
- [ ] `datetime` precision 3 + `timezone: 'Z'` 인가
- [ ] UNIQUE 위반을 errno 1062 로 감지하는가
