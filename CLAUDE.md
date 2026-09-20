# 프로모션 쿠폰 시스템 — NestJS / TypeORM 포팅

> 이 문서는 Claude Code 가 매 세션마다 자동으로 읽는 프로젝트 컨텍스트입니다.
> 새 작업을 시작하기 전에 이 문서의 결정사항을 반드시 준수해 주세요.
> 결정사항을 변경해야 한다고 판단되면, 먼저 사용자와 상의하세요.
>
> **본 프로젝트는 신규 개발이 아니라 포팅(migration)입니다.**
> source of truth 는 Java 원본: `~/dev/project/java/promotion-event`
> - 원본 `CLAUDE.md` — 도메인/ADR/안티패턴의 원천
> - 원본 `docs/design/api-spec.md` — **동결된 API 계약**
> - 원본 `docs/design/erd.md`, `server-*/src/main/resources/db/migration/*.sql` — **동결된 스키마**
>
> 본 문서와 원본 문서가 충돌하면, **언어 중립적 결정(ADR, API, 스키마)은 원본이 우선**하고
> **NestJS/TypeORM 구현 방식은 본 문서(§7, §11, §14)가 우선**합니다.

---

## 1. 프로젝트 목표

Java 21 / Spring Boot 3.5 / JPA 로 구현된 선착순 쿠폰 발급 시스템을
**NestJS + TypeORM** 으로 옮긴다. 외부 인프라(MySQL, Redis, Kafka)는 그대로 사용한다.

**성공 기준은 단 하나 — 스펙 동일성(parity)**:

| 동일해야 하는 것 | 근거 |
|---|---|
| 공개 API 4개 + 내부 API 2개의 경로/메서드/요청·응답 본문 | `docs/design/api-spec.md` |
| HTTP 상태코드 + 에러코드 **11종** + 응답 봉투 `{success, data \| error}` | 같음 (`api-spec.md` 는 10종만 적지만 b 의 `INTERNAL_STATE` 가 더 있다) |
| MySQL 테이블/컬럼/인덱스/제약 이름 | `db/migration/V*.sql` |
| Redis 키 이름 + 자료구조 + TTL | 원본 `RedisKeys.java` |
| Kafka 토픽 이름 + 메시지 payload 필드명 | 원본 `common/coupon/*.java` |
| ADR 11개의 **결정과 근거** | 원본 `CLAUDE.md` §6 |

**달라도 되는 것**: 언어 관용구, 파일 이름, 내부 클래스 구조, 성능 수치(Node 는 별도 측정).

---

## 2. 트래픽 시나리오 및 자원 제약 (원본 §2 승계)

| 항목 | 값 |
|------|------|
| 총 사용자 (피크) | 1,000 명 |
| 사용자당 요청 | 10 초 내 10 건 |
| 시스템 전체 목표 | **1,000 TPS** |
| 데이터 형식 | JSON, 10 개 필드 |
| 서버 사양 | vCPU 1, RAM 2 GB (server-a, b, c 각각) |

⚠️ **Java 측정치(인스턴스당 977 RPS)를 그대로 인용하지 말 것.**
Java 는 `threads.virtual.enabled: true` 로 요청당 가상 스레드를 썼지만 Node 는 **단일 이벤트 루프**다.
HTTP 핸들러 + Kafka consumer + 스케줄러가 **같은 루프를 공유**하므로 사이징은 반드시 재측정한다 (§14, ADR-N04).

---

## 3. 시스템 아키텍처 (원본 §4 그대로)

```
[User] ──HTTPS──▶ [server-a] ──sync HTTP──▶ [server-b] ──Kafka(issue)──▶ [server-c]
                  진입/검증/요청 로그        Redis 적재/접수 응답         재고 차감/영구 저장
                       │                          │   ▲                       │
                    [MySQL-A]                  [Redis] │                   [MySQL-C]
                  issue_request               pending  │ Kafka(result)       event
                  (per-request commit)        event cache ◀──────────────── coupon_type
                                                                            coupon_type_inventory
                                                                            user_coupon
                                                                            outbox_event
```

**A→B 는 동기 (단 응답은 "접수 완료"), B↔C 는 양방향 비동기 Kafka** 가 핵심 설계.

데이터 흐름 11단계의 상세는 원본 `docs/design/architecture.md` 를 읽을 것. 요약하지 말고 원문을 볼 것.

---

## 4. 서비스별 책임 (원본 §5 요약 — 상세는 원본 참조)

| 서버 | 포트 | 책임 | 저장소 | 절대 하지 말 것 |
|---|---|---|---|---|
| `server-a` | 8080 | 진입 · `X-User-Id` 인증 · SOLD_OUT 단락 · 요청 로그 per-request commit · B 호출(CB) | MySQL-A + Redis(읽기) | 재고 관리, 긴 트랜잭션, timeout/CB 없는 B 호출 |
| `server-b` | 8081 | 신청 Redis 적재 · Kafka publish · result consume · pending 스케줄러 · (원본은 B 에 event 캐시 API 없음 — 캐시는 C) | **Redis only** (MySQL 없음) | 재고 관리, Redis+Kafka 원자성 가정, consumer 내 긴 동기 호출 |
| `server-c` | 8082 | 영구 저장 · 재고 권위(비관락) · Outbox · redeem(낙관락) · event 캐시 | MySQL-C + Redis | UNIQUE 없는 메시지 처리, 트랜잭션 내 Kafka publish, consumer 내 동기 외부 호출 |

---

## 5. 기술 스택

| 카테고리 | Java 원본 | 본 프로젝트 |
|---|---|---|
| 런타임/언어 | Java 21 | **Node.js 22+ / TypeScript 6** |
| 프레임워크 | Spring Boot 3.5.14 | **NestJS 12** |
| 빌드 | Gradle (Kotlin DSL) 멀티모듈 | **Nest CLI 모노레포** (`apps/` + `libs/`) |
| ORM | Spring Data JPA + Hibernate | **TypeORM 1.1.x** + `@nestjs/typeorm` |
| DB 드라이버 | mysql-connector-j | `mysql2` |
| Migration | Flyway | **TypeORM migrations** (원본 SQL 그대로 이관) |
| Redis | Spring Data Redis (Lettuce) | **ioredis** |
| Kafka | Spring Kafka | **kafkajs** (직접 래핑 — `@nestjs/microservices` 미사용, ADR-N02) |
| Resilience | Resilience4j | **cockatiel** (CB + Retry + Timeout) |
| 스케줄러 | `@Scheduled` | `@nestjs/schedule` (`@Interval`) |
| 검증 | Bean Validation | `class-validator` + `class-transformer` + 전역 `ValidationPipe` |
| 예외 처리 | `@RestControllerAdvice` | `@Catch()` ExceptionFilter |
| 모니터링 | Actuator + Micrometer | `@nestjs/terminus` + `@prometheus-io/client` |
| 부하 테스트 | k6 | k6 (원본 `load-test/` 재사용) |
| 테스트 | JUnit 5 + Testcontainers | Jest + `testcontainers` (node) |
| 린트/포맷 | — | oxlint + prettier (이미 설정됨) |

의존성을 새로 추가할 때는 **본 표를 함께 갱신**한다.

---

## 6. ADR — 원본 승계 (ADR-001 ~ ADR-011)

원본 `CLAUDE.md` §6 의 ADR 11개는 **언어 중립적 결정**이므로 결정·근거·트레이드오프를 그대로 승계한다.
여기서는 각 ADR 이 본 프로젝트에서 **어떤 구현으로 내려앉는지**만 적는다. 근거가 궁금하면 원본을 읽을 것.

| ADR | 결정 요약 | NestJS/TypeORM 구현 |
|---|---|---|
| **001** | A→B 동기 호출, 즉시 "접수 완료" 응답 | `@nestjs/axios` + cockatiel policy, read-timeout 1000ms |
| **002** | Saga(choreography) + Outbox (C 에 위치) | `outbox_event` 테이블 + `@Interval(500)` poller. publish 는 **트랜잭션 밖** |
| **003** | 재고는 C 의 MySQL + 비관적 락 | `qb.setLock('pessimistic_write')` — 반드시 트랜잭션 `EntityManager` 로 |
| **004** | 멱등성 = `(user_id, coupon_type_id)` UNIQUE | 동일. `QueryFailedError` + `errno 1062` 로 중복 감지 |
| **005** | A 의 사용자별 Rate Limit 없음 | **`@nestjs/throttler` 도입 금지.** Backpressure 는 Kafka consumer throttle |
| **006** | Database per Service | **DataSource 2개** (`server-a` → `server_a`, `server-c` → `server_c`). b 는 DB 없음 |
| **007** | redeem 은 낙관적 락 | ⚠️ TypeORM 은 JPA 와 다름 → **ADR-N03 참조** |
| **008** | B 의 publish 보장 — producer 재시도 + 스케줄러 재발행 (cap 3) | `@Interval(1000)` + ioredis `ZRANGEBYSCORE`/`HINCRBY`. 30s SLA 유지 |
| **009** | B↔C 양방향 Kafka (issue / result 토픽) | kafkajs. throttle 은 `eachBatch` + 수동 커밋 (ADR-N02) |
| **010** | A 의 요청 로그는 per-request commit | `repository.save()` 1회, 트랜잭션 열지 않음 |
| **011** | 매진 negative cache (`coupon:available:{e}:{c}`, A 단락 + C 쓰기) | afterCommit → **트랜잭션 await 이후 코드**로 이동 (ADR-N01) |

---

## 7. ADR — NestJS 전용 (ADR-N01 ~ N06)

Java 에는 없던, 런타임 차이 때문에 새로 필요한 결정들.

### ADR-N01: 트랜잭션은 명시적 `dataSource.transaction()` — 데코레이터 미사용
- **결정**: `@nestjs-cls/transactional` 같은 AsyncLocalStorage 기반 `@Transactional()` 을 쓰지 않는다.
  애플리케이션 서비스가 `dataSource.transaction(async (em) => ...)` 로 경계를 열고,
  리포지토리 메서드는 **첫 인자로 `EntityManager` 를 받는다**.
- **근거**: 트랜잭션 경계가 코드에 그대로 드러나 추적이 쉽고, 의존성이 늘지 않는다.
  1 vCPU 환경에서 ALS 컨텍스트 전파 오버헤드도 피한다.
- **트레이드오프**: 리포지토리 시그니처가 Java 와 다르다 (`save(em, entity)`).
  이는 **의도된 차이**이며 spec parity 대상이 아니다.
- **`afterCommit` 대응**: Spring 의 `TransactionSynchronization.afterCommit` 은 등가물이 없다.
  `await dataSource.transaction(...)` **이후 줄**에서 실행한다. 의미(커밋 후 실행)는 동일하다.
  ADR-011 의 negative cache 적재가 여기 해당한다.

```ts
// ✅ 올바른 형태 (ADR-011 + ADR-N01)
async process(payload: CouponIssueRequestPayload): Promise<void> {
  let needsAvailabilityCheck = false;
  await this.dataSource.transaction(async (em) => {
    // ... 중복 체크 → 이벤트 유효성 → 비관락 차감 → user_coupon INSERT → outbox INSERT
    needsAvailabilityCheck = true;
  });
  // 커밋 후: fresh read 해서 0 이면 negative cache. 실패해도 삼킨다 (캐시는 권위 아님).
  if (needsAvailabilityCheck) await this.markSoldOutIfDepleted(eventId, couponTypeId);
}
```

### ADR-N02: Kafka 는 kafkajs 직접 래핑 — `@nestjs/microservices` 미사용
- **결정**: `@nestjs/microservices` 의 Kafka transport 대신 `kafkajs` 를 `@Injectable()` 프로바이더로 직접 감싼다.
- **근거**: ADR-009 의 throttle (`max.poll.records=10`, `concurrency=1`) 과 `ack-mode: RECORD` 를
  재현하려면 `eachBatch` + `autoCommit: false` + `resolveOffset()` 제어가 필요한데,
  Nest transport 는 이 수준의 제어를 노출하지 않는다. 1 vCPU 보호가 평가 항목 ④ 의 핵심이라 타협 불가.
- **적용**: `maxBytes`/`maxWaitTimeInMs` 로 배치 크기 제한, 레코드 1건 처리마다 `resolveOffset` + `heartbeat`.
- **생명주기**: `OnModuleInit` 에서 connect, `OnApplicationShutdown` 에서 disconnect.
  `app.enableShutdownHooks()` 를 `main.ts` 에 **반드시** 호출 (없으면 consumer 가 rebalance 를 남긴다).

### ADR-N03: 낙관적 락은 조건부 UPDATE + `affected` 검사 — `@VersionColumn` 단독 신뢰 금지
- **문제**: TypeORM 의 `@VersionColumn` 은 UPDATE 시 `version = version + 1` 을 SET 하지만
  **`WHERE version = N` 가드를 넣지 않는다** (`UpdateQueryBuilder` 확인).
  `OptimisticLockVersionMismatchError` 는 **읽기 시점**(`SelectQueryBuilder`)에서만 던져진다.
  즉 `save()` 만 하면 JPA `@Version` 과 동작이 다르고, 동시 redeem 이 **둘 다 성공**한다.
- **결정**: redeem 은 명시적 조건부 UPDATE 로 구현하고 `affected === 0` 이면 `409 RACE_RETRY`.
  `version` 컬럼은 스키마 parity 를 위해 유지하며 직접 증가시킨다.

```ts
const res = await em.createQueryBuilder()
  .update(UserCouponOrmEntity)
  .set({ status: 'USED', usedAt: now, version: () => 'version + 1' })
  .where('user_coupon_id = :id AND version = :v', { id, v: current.version })
  .execute();
if (res.affected === 0) throw new RaceRetryException(); // → 409 RACE_RETRY
```

### ADR-N04: 단일 이벤트 루프 — 역할별 프로세스 분리, 클러스터 미사용
- **결정**: `cluster` 모듈이나 PM2 다중 워커를 쓰지 않는다. 1 vCPU 에 워커를 늘리면 컨텍스트 스위칭만 늘어난다.
  수평 확장은 컨테이너 복제로 한다 (Java 와 동일한 모델).
- **결과**: `server-b`/`server-c` 는 HTTP 서버 + Kafka consumer + 스케줄러가 한 루프를 공유한다.
  → **이벤트 루프를 막는 코드는 곧 API latency**. 동기 대용량 JSON 직렬화, 긴 `for` 루프, `crypto` 동기 호출 금지.
- **사이징**: 원본 §2 의 977 RPS 는 **Java 측정치**다. Node 수치는 k6 로 독립 측정 후 `docs/` 에 별도 기록.

### ADR-N05: 스키마는 원본 Flyway SQL 을 그대로 이관 — `synchronize` 영구 금지
- **결정**: `V1__schema.sql` / `V2__add_event_status.sql` 의 DDL 을 TypeORM 마이그레이션의
  `queryRunner.query()` 안에 **문자열 그대로** 옮긴다. TypeORM 이 DDL 을 생성하게 두지 않는다.
- **근거**: 컬럼 타입(`DATETIME(3)`, `VARCHAR(20)`), 제약 이름(`uk_user_coupon_user_type`),
  인덱스 이름까지 parity 대상이다. TypeORM 의 `type: 'enum'` 은 MySQL `ENUM` 을 만들어 원본과 달라진다.
- **적용**: 모든 DataSource 에 `synchronize: false`, `migrationsRun: true`.
  엔티티는 `type: 'varchar', length: 20` + TS union 타입으로 상태값을 표현한다.

### ADR-N06: 프레임워크 오류는 상태코드를 살리고 본문만 봉투로 감싼다
- **문제**: `@Catch()` 를 인자 없이 쓰면 Nest 내부 예외까지 전부 잡힌다. 원본처럼 일괄 500 으로 뭉개면
  없는 경로가 404 대신 500 으로 나가 운영 중 오진단을 부르고, 그대로 통과시키면 이 경로만
  봉투가 아니게 된다 (Nest 기본 `{statusCode, message, error}`).
- **결정** (사용자 판단): 필터는 ① 앱이 정의한 계약 예외 → 봉투 + §4 의 계약 에러코드,
  ② `HttpException` → **상태코드 유지 + 본문만 봉투**, ③ 그 외 → 500 `INTERNAL_ERROR`.
  뼈대는 `libs/common` 의 `BaseExceptionFilter` 가 갖는다.
- **②의 에러코드는 원본에 없는 값**이다. HTTP 상태 이름을 그대로 쓴다
  (`404 → NOT_FOUND`, `405 → METHOD_NOT_ALLOWED`, `415 → UNSUPPORTED_MEDIA_TYPE`).
  §4 표의 계약 11종과 **별개의 집합**이니 혼동하지 말 것 — 404 의 `NOT_FOUND` 는
  server-c 의 계약 코드와 문자열만 우연히 겹친다.
- **Java 와의 차이**: 원본은 `@ExceptionHandler(Exception.class)` 가 없는 경로/405/415 를 전부 잡아
  **500 `INTERNAL_ERROR` 봉투**를 낸다. 우리는 상태코드를 유지한다.
  스펙에 없는 경로라 계약 API 에는 영향이 없다.
- **`/actuator/health` 는 예외**: Terminus 의 `@HealthCheck()` 를 쓰면 실패가
  `ServiceUnavailableException` 으로 떠서 이 필터가 봉투를 씌우고 Actuator 형태가 깨진다.
  health 컨트롤러가 직접 `503 + {"status":"DOWN"}` 을 쓴다.
- **깨진 JSON 은 필터로 오지 않는다**: Nest 기본 파서는 파싱 실패를 `BadRequestException` 으로 바꾸면서
  `cause`/`type`/`body` 를 전부 지운다 → 구조적으로 판별 불가. 그래서
  `NestFactory.create(..., { bodyParser: false })` + `useEnvelopeAwareBodyParser(app)` 로
  파서를 직접 소유하고, 라우터 앞단에서 `MALFORMED_BODY` 봉투를 직접 쓴다.

---

## 8. 모듈 구조

```
coupon-api-nestjs/
├── CLAUDE.md                       ← 본 문서
├── nest-cli.json                   ← monorepo: projects a/b/c + lib common
├── package.json / tsconfig.json
├── docker-compose.yml              ← (원본 것을 이관, 포트 충돌 주의)
│
├── libs/common/src/                ← = Gradle :common + 앱 공통 API 기반
│   ├── coupon/                     coupon-code.ts, payloads.ts, statuses.ts
│   ├── api/                        응답 봉투, 에러 타입, ValidationPipe, body parser,
│   │                               BaseExceptionFilter, @UserId(), actuator 변환
│   └── persistence/                buildMysqlOptions() — ADR-N05 고정값의 단일 정의
│
├── apps/server-a/src/              ← :8080
│   ├── main.ts
│   ├── server-a.module.ts
│   ├── api/            controller, dto/, filters/
│   ├── application/    *.service.ts, *.command.ts, *.outcome.ts
│   ├── domain/         issue-request.ts, issue-request.repository.ts(abstract), *.enum.ts
│   └── infrastructure/ persistence/  redis/  client/  config/
│
├── apps/server-b/src/              ← :8081  (DB 없음 — Redis only)
├── apps/server-c/src/              ← :8082
│
├── migrations/
│   ├── server-a/                   원본 V1__schema.sql 이관
│   └── server-c/                   원본 V1, V2 이관
│
├── test/                           e2e (spec parity 검증)
└── docs/                           Node 기준 측정 결과만. 설계 문서는 원본을 링크
```

실행: `npm run start:dev server-a` / `server-b` / `server-c`

---

## 9. 도메인 모델 (원본 §9 그대로 — 이름 변경 금지)

### server-a — MySQL schema `server_a`
- `issue_request` (id PK, request_id, user_id, event_id, coupon_type_id, status, created_at)

### server-b — Redis only
- `issue:pending:{user_id}:{coupon_type_id}` — Hash (`status`, `createdAt`, `eventId`, `requestId`, `userId`, `couponTypeId`, `publishAttempts`, `lastPublishedAt`, `code`)
- `issue:pending:zset` — ZSet (member `{user_id}:{coupon_type_id}`, score = lastPublishedAt epoch ms)
- `event:{event_id}` — Hash (캐시, TTL 300s) — **쓰는 주체는 server-c**
- `coupon:available:{event_id}:{coupon_type_id}` — SOLD_OUT negative cache, TTL 24h. **C 가 쓰고 A 가 읽음**

### server-c — MySQL schema `server_c`
`event` / `coupon_type` / `coupon_type_inventory` / `user_coupon` / `outbox_event`
— 컬럼·제약·인덱스는 원본 `docs/design/erd.md` 와 `V*.sql` 이 권위.

### Kafka 토픽
- `coupon-issue-request` — B → C
- `coupon-issue-result` — C → B

---

## 10. 절대 하지 말 것 (Anti-patterns)

원본 §10 을 모두 승계한다. 아래는 **NestJS/TypeORM 에서 추가되는 것**.

- ❌ `synchronize: true` (ADR-N05 위반 — 스키마가 조용히 달라진다)
- ❌ `@VersionColumn` 만 믿고 `save()` 로 낙관적 락 기대 (ADR-N03)
- ❌ `type: 'enum'` 컬럼 (MySQL ENUM 생성 — 원본은 VARCHAR)
- ❌ **ORM 엔티티의 BIGINT 를 도메인 값과 직접 비교** — mysql2 는 BIGINT 를 **string** 으로 준다.
  ID 표현은 계층별로 고정이다: **wire/도메인 = `number`, ORM 엔티티 = `string`**,
  변환은 매퍼 한 곳에서만. `userId` 소유권 검증(404 마스킹)이 조용히 깨지는 지점이다
- ❌ 트랜잭션 콜백 밖의 `EntityManager` 를 콜백 안에서 사용 (락이 걸리지 않는다)
- ❌ 이벤트 루프를 막는 동기 코드 (ADR-N04)
- ❌ `@nestjs/throttler` 도입 (ADR-005 — Rate Limit 은 의도적으로 없음)
- ❌ `@nestjs/microservices` Kafka transport (ADR-N02)
- ❌ 원본에 없는 API/필드/에러코드 추가 (§1 parity)
- ❌ `app.enableShutdownHooks()` 누락
- ❌ 헥사고날 아키텍처 도입 (원본 §10 — 레이어드 + 경량 DDD 로 충분)

---

## 11. 코딩 컨벤션

### 레이어 규칙 (상세는 `nest-ddd-layering` 스킬)
```
api → application → domain
                ↖ infrastructure (domain 의 abstract 를 구현)
```
- `domain/` 은 **아무것도 import 하지 않는다** — `@nestjs/*`, `typeorm`, `ioredis` 전부 금지. 순수 TS.
- 리포지토리는 `domain/` 에 **abstract class** 로 선언 (interface 는 DI 토큰이 될 수 없다).
  구현은 `infrastructure/persistence` 에서 `{ provide: XxxRepository, useClass: TypeOrmXxxRepository }`.
- 트랜잭션 경계는 `application/` 에만 존재한다 (ADR-N01).

### 모델 분리 수준
- **쓰기 애그리거트만 분리**: `UserCoupon`, `CouponTypeInventory`, `IssueRequest`, `PendingIssue`
  → 순수 도메인 모델 + `*.mapper.ts` + `*.orm-entity.ts`
- **읽기 전용 경로**는 ORM 엔티티를 읽기 모델로 직접 사용 (`EventQueryService`, `UserCouponQueryService`)
  → 매퍼 보일러플레이트를 만들지 않는다 (원본 §10 "scope discipline")

### 파일 네이밍
| 종류 | 형식 | 예 |
|---|---|---|
| 도메인 모델 | `<name>.ts` | `domain/user-coupon.ts` |
| 리포지토리 추상 | `<name>.repository.ts` | `domain/user-coupon.repository.ts` |
| ORM 엔티티 | `<name>.orm-entity.ts` | `infrastructure/persistence/user-coupon.orm-entity.ts` |
| 리포지토리 구현 | `typeorm-<name>.repository.ts` | |
| 애플리케이션 서비스 | `<name>.service.ts` | `application/redeem-coupon.service.ts` |
| DTO | `<name>.dto.ts` | `api/dto/issue-coupon-request.dto.ts` |

### 기타
- 예외: 도메인 예외는 `domain/exception/`, HTTP 매핑은 `api/filters/` 의 ExceptionFilter 한 곳에서
- 로깅: Nest `Logger`. 구조화 필드 사용 (`logger.log(\`issued: code=${code}, userId=${userId}\`)`)
- 주석: **비즈니스 결정/트레이드오프는 반드시 남긴다.** 원본 Java 주석에 담긴 근거를 그대로 옮길 것
- 테스트: 동시성/멱등성은 통합 테스트 (testcontainers). 100% 커버리지 목표 없음

---

## 12. 작업 순서 (권장)

1. **기반** — 모노레포 전환 (`nest-cli.json`, `apps/`, `libs/`), DataSource 2개, 마이그레이션 이관, 공통 응답 봉투 + ExceptionFilter
2. **server-c** — 가장 복잡하고 권위를 쥔 쪽. 엔티티 → 리포지토리 → `CouponIssueProcessor`(비관락) → `RedeemCouponService`(ADR-N03) → Outbox poller → event 캐시 → Kafka consumer
3. **server-b** — Redis store → accept 서비스 → Kafka producer/consumer → pending 스케줄러 (ADR-008)
4. **server-a** — negative cache 단락 → CB 클라이언트 → issue 컨트롤러
5. **검증** — e2e 로 API 계약 대조 → k6 재측정 → 사이징 문서화

각 단계 끝에서 `spec-auditor` 에이전트로 원본 대조를 돌린다.

---

## 13. 서브에이전트 / 스킬

| 이름 | 종류 | 언제 |
|---|---|---|
| `spec-parity` | skill | API/스키마/키/토픽을 건드리기 **전** |
| `nest-ddd-layering` | skill | 새 파일/클래스를 만들기 전 |
| `typeorm-patterns` | skill | 엔티티·트랜잭션·락·마이그레이션 작업 시 |
| `java-to-nest-porting` | skill | 원본 파일을 옮길 때 (매 파일) |
| `spec-auditor` | agent | 모듈 포팅 완료 직후 — 원본과 동작 대조 |
| `nest-code-reviewer` | agent | 코드 작성/리팩토링 완료 직후 |

---

## 14. Claude Code 작업 시 주의사항

- **원본을 추측하지 말고 읽는다.** `~/dev/project/java/promotion-event` 의 해당 파일을 실제로 열어볼 것.
  요약본(본 문서)은 색인일 뿐 권위가 아니다.
- 새 코드 작성 전, §6/§7 의 ADR 과 §10 안티패턴을 먼저 확인
- 설계 결정과 충돌이 의심되면 **코드 작성 전에** 사용자에게 질문
- 원본에 없는 기능·필드·엔드포인트를 "개선" 명목으로 추가하지 않는다 (§1)
- 새 의존성 추가 시 §5 표를 함께 갱신
- 커밋 메시지: `feat(server-c): pessimistic-lock inventory decrement` 형식
