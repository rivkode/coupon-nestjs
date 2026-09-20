# coupon-api-nestjs

선착순 쿠폰 발급 시스템 — **Java 21 / Spring Boot 3.5 / JPA → NestJS 12 / TypeORM 1.x 포팅**

원본: [`~/dev/project/java/promotion-event`](../../java/promotion-event) (Gradle 멀티모듈)
외부 인프라(MySQL · Redis · Kafka)는 원본 그대로 사용한다.

> 이 프로젝트의 성공 기준은 기능 개선이 아니라 **스펙 동일성(parity)** 이다.
> API 경로·응답 봉투·에러코드·테이블/컬럼명·Redis 키·Kafka 토픽은 한 글자도 바꾸지 않는다.
> 설계 결정과 작업 규칙은 [`CLAUDE.md`](./CLAUDE.md) 참조.

---

## 구조

Nest CLI 모노레포 — 원본의 Gradle 서브프로젝트와 1:1 대응한다.

| 앱 | 포트 | 책임 | 저장소 |
|---|---|---|---|
| `apps/server-a` | 8080 | 진입 · `X-User-Id` 인증 · 매진 단락 · 요청 로그 · B 호출(Circuit Breaker) | MySQL-A + Redis(읽기) |
| `apps/server-b` | 8081 | Redis 적재 → 즉시 "접수 완료" → Kafka publish → 결과 캐시 → pending 스케줄러 | **Redis only** |
| `apps/server-c` | 8082 | 영구 저장 · 재고 권위(비관적 락) · Outbox · redeem(낙관적 락) · 이벤트 캐시 | MySQL-C + Redis |
| `libs/common` | — | 공통 payload/enum + 응답 봉투 · 예외 · 파이프 · DataSource 옵션 | — |

각 앱은 `api / application / domain / infrastructure` 4계층 (레이어드 + 경량 DDD, 헥사고날 미사용).

```
apps/server-x/src/
├── api/              컨트롤러, DTO, 전역 예외 필터
├── application/      유스케이스 + 트랜잭션 경계
├── domain/           순수 TS 모델, 리포지토리 추상 클래스, 도메인 예외
└── infrastructure/   ORM 엔티티·매퍼·리포지토리 구현, Redis, Kafka, HTTP 클라이언트
```

---

## 실행

### 사전 준비

MySQL 2대 · Redis · Kafka 가 필요하다. **이 리포의 `docker-compose.yml`** 을 쓴다.

```bash
docker compose up -d
docker compose ps          # 넷 다 healthy 가 될 때까지 대기
```

원본과 같은 이미지·같은 설정이지만, 호스트에서 돌고 있는 다른 프로젝트와 겹치지 않도록
**포트만 옮겼다**. 컨테이너 내부 포트와 스키마 이름은 원본 그대로다.

| 인프라 | 호스트 포트 | 원본 | 비고 |
|---|---|---|---|
| MySQL-A | 3306 | 3306 | schema `server_a` |
| MySQL-C | 3307 | 3307 | schema `server_c` |
| Redis | **6381** | 6379 | jamo-redis 가 6380 을 쓴다 |
| Kafka | **29093** | 29092 | HOST 리스너 |

> Kafka 호스트 포트를 바꿀 때는 compose 의 `KAFKA_LISTENERS` 와 `KAFKA_ADVERTISED_LISTENERS` 의
> HOST 포트도 **같이** 바꿔야 한다. advertised 가 다르면 클라이언트가 접속 후 엉뚱한 포트로 재접속한다.

> 원본 리포의 compose 와 **동시에 띄우지 말 것** — 앱 포트 8080~8082 가 겹친다.

접속 정보는 `.env` 에 있다 (`.env.example` 복사).

### 마이그레이션

원본 Flyway SQL 을 TypeORM 마이그레이션으로 그대로 옮겼다 (DDL 원문 유지).
앱 부팅 시 `migrationsRun: true` 로 자동 적용되지만, 수동 실행도 가능하다.

```bash
npm run migration:a   # server_a (:3306)
npm run migration:c   # server_c (:3307)
```

a 와 c 는 서로 다른 MySQL 인스턴스라 포트 환경변수가 분리되어 있다 (`DB_PORT_A` / `DB_PORT_C`).

### 앱 실행

```bash
npm install

npm run start:a   # :8080  watch 모드
npm run start:b   # :8081
npm run start:c   # :8082

# 프로덕션
npm run build
npm run start:prod:a
```

헬스체크는 원본과 같은 경로다.

```bash
curl -s localhost:8080/actuator/health   # {"status":"UP",...}
```

---

## 검증

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # oxlint (type-aware)
npm run test          # 단위 테스트
npm run test:e2e      # 계약 테스트 (응답 봉투 / 에러코드 매핑)
npm run format        # prettier
```

| 테스트 | 무엇을 고정하는가 |
|---|---|
| `test/envelope.e2e-spec.ts` | 응답 봉투 · 에러코드 매핑. 특히 **server-b 만 다른 두 지점**(`INTERNAL_STATE` 500, `MISSING_HEADER` 핸들러 부재)은 원본의 의도된 차이이므로 통일하지 말 것 |
| `test/server-c/persistence.e2e-spec.ts` | 동시성/멱등성 — 비관락 oversell 방지(ADR-003), 조건부 UPDATE 낙관락(ADR-N03), UNIQUE 제약 구분(ADR-004) |

영속 계층 테스트는 실제 MySQL 이 필요하고 **전용 스키마 `server_c_test`** 를 쓴다 (개발 DB 오염 방지):

```bash
docker compose up -d
docker exec coupon-mysql-c mysql -uroot -prootpassword \
  -e "CREATE DATABASE IF NOT EXISTS server_c_test; GRANT ALL ON server_c_test.* TO 'promotion'@'%';"
DB_NAME_C=server_c_test npm run migration:c
npm run test:e2e
```

---

## 문서

| 문서 | 내용 |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | 프로젝트 헌법 — ADR(원본 승계 11 + NestJS 전용 6), 안티패턴, 코딩 컨벤션 |
| `.claude/skills/spec-parity` | 동결된 계약 표 (API · 에러코드 · 스키마 · Redis 키 · Kafka payload) |
| `.claude/skills/nest-ddd-layering` | 계층 규칙, DI 토큰 관례, 모델 분리 기준 |
| `.claude/skills/typeorm-patterns` | 트랜잭션 · 락 · 마이그레이션 표준 + 검증된 함정 |
| `.claude/skills/java-to-nest-porting` | 포팅 절차와 Spring/Java → Nest/TS 치환표 |

설계의 원천(요구사항 · 아키텍처 · ERD · API 명세 · ADR 근거)은 **원본 리포의 `docs/`** 에 있다.
여기서 요약본을 다시 만들지 않는다 — 원문을 읽는다.

---

## 진행 상황

- [x] **1단계 — 기반**: 모노레포 전환, DataSource 2개, 마이그레이션 이관, 응답 봉투 + 전역 예외 필터, 헬스체크
- [x] **2단계 — `server-c`**: 엔티티 5 → 리포지토리 → 발급 트랜잭션(비관락) → redeem(낙관락, ADR-N03) → Outbox poller → 이벤트 캐시(Refresh-Ahead) → Kafka consumer(throttle) → 공개 API 3 + internal API 1
- [ ] 3단계 — `server-b`: Redis store → 접수 서비스 → Kafka producer/consumer → pending 스케줄러
- [ ] 4단계 — `server-a`: 매진 단락 → Circuit Breaker 클라이언트 → 발급 컨트롤러
- [ ] 5단계 — 검증: e2e 계약 대조 → k6 재측정 → 사이징 문서화
