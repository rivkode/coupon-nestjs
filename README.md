# 쿠폰 발급 시스템 (NestJS)

선착순 쿠폰 발급 시스템입니다. **1 vCPU / 2 GB 인스턴스에서 1,000 TPS 를 유실 없이 처리하는 것**이 목표이며,
기술스택은 Node.js 22, NestJS 12, TypeORM 1.x, MySQL, Redis, Kafka 를 사용한 모노레포 프로젝트입니다.

아키텍처(서비스 분리, 비동기 발급, Outbox, 비관적 락)는 [Java/Spring 구현](../../java/promotion-event)에서
먼저 검증한 설계를 따릅니다. 이 저장소의 기술 보고서는 **같은 설계를 Node 런타임에서 실제로 성립시키기 위해
무엇이 달랐고 무엇을 바꿨는지**를 다룹니다.

---

# 문서

## 쿠폰 서비스 설계

- [시스템 아키텍처 (data-flow)](docs/design/architecture.md)
- [ERD / 데이터 모델](docs/design/erd.md)
- [API 명세](docs/design/api-spec.md)
- [기술 결정 기록](docs/decisions/README.md)

## 기술 보고서

- [Kafka — kafkajs 운영 보고서](docs/reports/kafka.md)
  - Spring Kafka 의 `max.poll.records` / `ack-mode` / `fail-fast` 에 kafkajs 는 **대응 옵션이 없거나 기본값이 반대**다. 그대로 옮겼다가 메시지 유실과 오프셋 미커밋이 났고, 세 옵션을 맞물려 설정해 해결했다.
- [동시성 제어](docs/reports/concurrency.md)
  - 재고는 `SELECT ... FOR UPDATE` 로 직렬화한다. 반면 **TypeORM 의 `@VersionColumn` 은 낙관적 락으로 동작하지 않아** 조건부 UPDATE + `affected` 판정으로 구현했다.
- [분산 정합성](docs/reports/consistency.md)
  - Redis 적재 시점부터 at-least-once. Outbox 로 결과를 안전 발행하고, `(user_id, coupon_type_id)` UNIQUE 가 1인 1장 멱등을 보장한다. 유실 시 보완 스케줄러가 **30초 안에 SUCCESS 또는 FAILED 로 결론**을 낸다.
- [캐시 전략](docs/reports/cache.md)
  - 갱신 주기(60초) < TTL(300초) 로 두어 TTL 만료 자체를 없앤다. 매진은 negative cache 로 진입부에서 단락한다.
- [Node 런타임 제약](docs/reports/runtime.md)
  - 단일 이벤트 루프라 HTTP·consumer·스케줄러가 같은 루프를 공유한다. 부팅을 막는 `await` 하나가 포트 바인딩을 수십 초 지연시켰고, 의존 컴포넌트 연결은 전부 비차단으로 바꿨다.
- [부하 검증](docs/reports/load-test.md)
  - 설계 시나리오에서 **993 req/s, 실패 0%, p95 61ms** 로 목표를 만족한다. 요청의 **97%가 A 에서 매진 단락**되는 것이 성립 근거다. 반면 재고를 크게 잡아 전 구간 부하를 유지하면 server-c 의 소비 속도(약 96 msg/s)가 상한이 되고 스케줄러 되먹임으로 무너진다.

## 부하 검증 결과

목표는 사용자 1,000 명이 10 초 동안 1 인당 10 건을 요청하는 **1,000 TPS** 입니다.
쿠폰 100장 기준(요구사항이 전제하는 상황)으로 60초간 측정했습니다.

| 항목 | 값 |
|---|---|
| 처리량 | **992.9 req/s** (59,578 건) |
| 실패율 | **0.000%** |
| latency | avg 24.6ms · med 5.2ms · **p95 61.2ms** |
| 발급 정확도 | 재고 100 → 발급 정확히 100, 초과 0 |
| 유실 | A 접수 1,678 = C 처리 1,678 |
| 30초 SLA | `pending_scheduler_give_up` 0 |

읽는 데 필요한 단서 세 가지.

- 중앙값이 5.2ms 인 이유는 **전체 요청의 97.2%가 A 의 매진 단락에서 끝나기 때문**입니다.
  이 요청들은 B 의 Redis 적재도, Kafka 왕복도, C 의 비관적 락도 쓰지 않습니다.
- 재고를 10,000 으로 키워 모든 요청이 전 구간을 통과하게 하면 **503 이 65%** 로 무너집니다.
  server-c 의 소비 속도(약 96 msg/s)가 상한이고, 백로그가 스케줄러 재발행 되먹임을 만듭니다.
- 이 측정은 **1 vCPU 제약이 적용되지 않은 호스트(M1 Pro)** 기준입니다.
  목표 사양 수치를 알려면 컨테이너 CPU 제한을 걸고 다시 재야 합니다.

---

# 실행

## 인프라

MySQL 2대 · Redis · Kafka 가 필요합니다. 이 저장소의 `docker-compose.yml` 을 사용합니다.

```bash
docker compose up -d
docker compose ps          # 넷 다 healthy 가 될 때까지 대기
```

호스트에서 돌고 있는 다른 프로젝트와 겹치지 않도록 포트를 옮겨 두었습니다.
컨테이너 내부 포트와 스키마 이름은 그대로입니다.

| 인프라 | 호스트 포트 | 비고 |
|---|---|---|
| MySQL-A | 3306 | schema `server_a` |
| MySQL-C | 3307 | schema `server_c` |
| Redis | 6381 | — |
| Kafka | 29093 | HOST 리스너 |

> Kafka 호스트 포트를 바꿀 때는 compose 의 `KAFKA_LISTENERS` 와 `KAFKA_ADVERTISED_LISTENERS` 의
> HOST 포트도 **같이** 바꿔야 합니다. advertised 가 다르면 클라이언트가 접속 후 엉뚱한 포트로 재접속합니다.

## 애플리케이션

```bash
npm install
cp .env.example .env

npm run start:a       # :8080
npm run start:b       # :8081
npm run start:c       # :8082
```

앱 부팅 시 마이그레이션이 자동 적용됩니다(`migrationsRun: true`). 수동 실행은 선택입니다.

```bash
npm run migration:a   # server_a (:3306)
npm run migration:c   # server_c (:3307)
```

동작 확인:

```bash
curl -s localhost:8080/actuator/health      # {"status":"UP"}
curl -s localhost:8081/actuator/prometheus  # 보완 스케줄러 카운터 (30초 SLA 관측)
```

## 검증

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # oxlint (type-aware)
npm run test          # 단위 테스트
npm run test:e2e      # API 계약 + 영속 계층 통합 테스트
```

영속 계층 테스트는 실제 MySQL 이 필요하고 **전용 스키마 `server_c_test`** 를 사용합니다.

```bash
docker exec coupon-mysql-c mysql -uroot -prootpassword \
  -e "CREATE DATABASE IF NOT EXISTS server_c_test; GRANT ALL ON server_c_test.* TO 'promotion'@'%';"
DB_NAME_C=server_c_test npm run migration:c
npm run test:e2e
```

---

# 구조

Nest CLI 모노레포. 서비스별로 저장소를 분리합니다 (Database per Service).

| 앱 | 포트 | 책임 | 저장소 |
|---|---|---|---|
| `apps/server-a` | 8080 | 진입 · 인증 · 매진 단락 · 요청 로그 · B 호출(Circuit Breaker) | MySQL-A + Redis(읽기) |
| `apps/server-b` | 8081 | 신청 적재 → 즉시 접수 응답 → Kafka 발행 → 결과 캐시 → 보완 스케줄러 | **Redis only** |
| `apps/server-c` | 8082 | 영구 저장 · 재고 권위(비관적 락) · Outbox · 쿠폰 사용 | MySQL-C + Redis |
| `libs/common` | — | 공통 payload/enum, 응답 봉투, 예외, 파이프, DataSource 옵션 | — |

각 앱은 4계층입니다 (레이어드 + 경량 DDD).

```
apps/server-x/src/
├── api/              컨트롤러, DTO, 전역 예외 필터
├── application/      유스케이스 + 트랜잭션 경계
├── domain/           순수 TS 모델, 리포지토리 추상 클래스, 도메인 예외
└── infrastructure/   ORM 엔티티·매퍼·리포지토리 구현, Redis, Kafka, HTTP 클라이언트
```

`domain/` 은 프레임워크를 import 하지 않습니다. 리포지토리는 `domain/` 에 abstract class 로 선언하고
`infrastructure/` 에서 구현을 바인딩합니다.

---

# 진행 상황

- [x] 기반 — 모노레포, DataSource 2개, 마이그레이션, 응답 봉투 + 전역 예외 필터
- [x] `server-c` — 발급 트랜잭션(비관적 락), 쿠폰 사용(낙관적 락), Outbox, 이벤트 캐시, Kafka consumer
- [x] `server-b` — Redis 적재, 접수 API, Kafka 양방향, 보완 스케줄러(30초 SLA)
- [x] `server-a` — 매진 단락, Circuit Breaker, 발급 요청 API
- [x] 부하 검증 — k6 측정 (설계 시나리오 1,000 TPS 만족)
- [ ] 1 vCPU 제약 하 재측정 및 인프라 사이징
