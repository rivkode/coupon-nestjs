# 기술 결정 기록

## 📚 문서 목록

- [시스템 아키텍처](../design/architecture.md)
- [ERD / 데이터 모델](../design/erd.md)
- [API 명세](../design/api-spec.md)
- **기술 결정 기록** ← 현재 문서

[← README](../../README.md)

---

## 설계 차원의 결정

아키텍처 결정(서비스 분리, 비동기 발급, 비관적 락, Outbox, 멱등성)은
[Java/Spring 구현](../../../../java/promotion-event)에서 먼저 검증했다. 요약은 다음과 같다.

| 결정 | 내용 |
|---|---|
| 응답 모델 | A→B 는 동기이되 B 는 적재 후 **즉시 "접수 완료"**. 결과는 조회로 확인 |
| 분산 트랜잭션 | Choreography Saga + **Outbox** (C 에 위치). Orchestrator 를 두지 않는다 |
| 재고 | C 의 MySQL row + **비관적 락**. Redis 는 캐시일 뿐 권위가 아니다 |
| 멱등성 | `(user_id, coupon_type_id)` UNIQUE. Idempotency-Key 헤더 미사용 |
| Rate Limit | 사용자별 제한 없음 — 1인 1장 제약이 자연 차단. Backpressure 는 consumer throttle |
| 저장소 | Database per Service. 서비스 간 물리 FK 없음 |
| 쿠폰 사용 | 낙관적 락. 동시 사용 시도는 발급보다 훨씬 드물다 |
| 발행 보장 | producer 재시도 + 보완 스케줄러 재발행 (cap 3 → 30초 결론) |
| 매진 캐시 | negative cache 로 **A 진입부에서 단락** |

---

## Node/NestJS 환경에서 새로 내린 결정

같은 설계를 Node 런타임에서 성립시키기 위해 필요했던 결정들이다.

### D-1. 트랜잭션은 명시적 경계로 둔다

`@Transactional` 데코레이터 라이브러리를 쓰지 않는다.
애플리케이션 서비스가 `dataSource.transaction(async (tx) => ...)` 로 경계를 열고,
리포지토리는 트랜잭션 컨텍스트를 첫 인자로 받는다.

- 경계가 코드에 드러나 추적이 쉽다
- 1 vCPU 에서 AsyncLocalStorage 전파 오버헤드를 피한다
- `afterCommit` 은 트랜잭션 await **이후 줄**에서 실행한다

→ [동시성 제어](../reports/concurrency.md)

### D-2. Kafka 는 kafkajs 를 직접 감싼다

`@nestjs/microservices` 의 Kafka transport 는 `max.poll.records` 와 수동 커밋 제어를 노출하지 않는다.
1 vCPU 보호를 위한 throttle 이 유량 제어의 핵심이라 타협할 수 없어 kafkajs 를 직접 쓴다.

→ [Kafka](../reports/kafka.md)

### D-3. 낙관적 락은 조건부 UPDATE 로 구현한다

TypeORM 의 `@VersionColumn` 은 `WHERE version = ?` 가드를 넣지 않아 낙관적 락으로 동작하지 않는다.
`version` 컬럼은 유지하되 평범한 `@Column` 으로 매핑하고, 조건부 UPDATE + `affected` 로 판정한다.

→ [동시성 제어](../reports/concurrency.md)

### D-4. 단일 이벤트 루프를 전제로 설계한다

`cluster` 워커를 쓰지 않는다. 수평 확장은 컨테이너 복제로 한다.
HTTP·consumer·스케줄러가 한 루프를 공유하므로 블로킹 코드는 곧 API 지연이다.
주기 작업에는 겹침 가드를 둔다.

→ [Node 런타임 제약](../reports/runtime.md)

### D-5. 스키마는 SQL 원문으로 관리한다

TypeORM 이 DDL 을 생성하게 두지 않는다 (`synchronize: false`).
마이그레이션은 `queryRunner.query()` 에 SQL 을 직접 쓴다 — 컬럼 타입, 제약 이름, 인덱스 이름이
ORM 의 생성 규칙에 좌우되지 않게 하기 위해서다.

### D-6. 의존 컴포넌트 연결은 부팅을 막지 않는다

Kafka admin·producer·consumer 연결, 스케줄러 첫 실행 모두 `await` 하지 않는다.
브로커 장애가 HTTP API 중단으로 번지면 안 된다. 대신 **실패하면 백그라운드에서 재시도**한다.

→ [Node 런타임 제약](../reports/runtime.md)

### D-7. 프레임워크 오류는 상태코드를 유지한다

전역 예외 필터가 `HttpException`(없는 경로·405·415)을 500 으로 뭉개지 않는다.
상태코드는 살리고 본문만 응답 봉투로 감싼다. 운영 중 오진단을 막기 위해서다.
단, `/actuator/health` 의 503 은 필터를 거치지 않고 Actuator 형식을 유지한다.
