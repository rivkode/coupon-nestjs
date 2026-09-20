---
name: spec-parity
description: Java 원본(promotion-event)과 동일해야 하는 계약 — 공개/내부 API 6개, 응답 봉투, 에러코드 11종, HTTP 상태코드, MySQL 테이블·컬럼·제약 이름, Redis 키·자료구조·TTL, Kafka 토픽·payload 필드 — 을 동결 표로 보관하고 대조를 강제한다. 컨트롤러/DTO/엔티티/마이그레이션/Redis 키/Kafka 메시지를 만들거나 고치기 직전에 PROACTIVELY 사용한다. "API", "응답", "에러코드", "스키마", "테이블", "Redis 키", "토픽", "payload" 가 언급되면 반드시 이 스킬을 먼저 거친다.
---

# Spec Parity — 동결된 계약

본 프로젝트는 포팅이다. 아래 값들은 **한 글자도 바꾸지 않는다.**
"더 나은 이름", "더 RESTful 한 경로", "불필요해 보이는 필드"라는 판단이 들면 **바꾸지 말고 사용자에게 질문**한다.

> 권위 문서: `~/dev/project/java/promotion-event/docs/design/api-spec.md`, `docs/design/erd.md`,
> `server-*/src/main/resources/db/migration/V*.sql`, `common/src/main/java/com/promotion/common/coupon/*.java`
> 본 스킬의 표와 원본이 다르면 **원본이 권위**다. 그때는 본 스킬을 고친다.

---

## 1. 공개 API (4)

| # | 메서드 · 경로 | 서버 | 인증 | 성공 |
|---|---|---|---|---|
| 1 | `POST /api/v1/coupons/issue-request` | a :8080 | `X-User-Id` 필수 | **200** |
| 2 | `POST /api/v1/coupons/{code}/redeem` | c :8082 | `X-User-Id` 필수 | **200** |
| 3 | `GET  /api/v1/users/me/coupons` | c :8082 | `X-User-Id` 필수 | 200 (배열, `issued_at DESC`, 페이지네이션 없음) |
| 4 | `GET  /api/v1/events/{eventId}` | c :8082 | **없음** | 200 |

⚠️ **POST 의 성공 코드는 201 이 아니라 200 이다.** Nest 의 `@Post()` 는 기본이 201 이므로
`@HttpCode(HttpStatus.OK)` 를 반드시 붙인다. 원본은 셋 다 `ResponseEntity.status(HttpStatus.OK)` 다.
(#5 의 raw 응답도 200)

## 2. 내부 API (2)

| # | 메서드 · 경로 | 서버 | 호출자 | 인증 | 비고 |
|---|---|---|---|---|---|
| 5 | `POST /internal/v1/coupons/issue` | b :8081 | server-a | `X-User-Id` **필수** | **응답 봉투 없이 raw payload** |
| 6 | `GET /internal/v1/users/{userId}/coupons/{couponTypeId}` | c :8082 | server-b 스케줄러 | 없음 (path 로 식별) | **봉투 사용**. 미처리 시 404 `NOT_FOUND` |

⚠️ #5 는 `X-User-Id` 가 필수인데 **server-b 에는 MISSING_HEADER 핸들러가 없다** (§4).
헤더를 빼먹으면 400 이 아니라 **500 `INTERNAL_ERROR`** 가 나간다. 이 조합을 기억할 것.

⚠️ #4 는 컨트롤러가 헤더를 **아예 받지 않는다** (`@PathVariable` 만). "선택" 이 아니라 "없음" 이다.

## 3. 응답 봉투

```jsonc
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "...", "message": "...", "fieldErrors": [ { "field": "...", "message": "..." } ] } }
```
- `null` 필드는 직렬화에서 **생략** (Java `@JsonInclude(NON_NULL)`).
- **예외**: `#3` 응답의 `usedAt` 은 `null` 이어도 **생략하지 않는다** ("아직 안 썼다"가 의미 있는 정보).
- `#5` 는 봉투를 쓰지 않는다.

## 4. 에러코드 (11) — 하나도 늘리거나 줄이지 않는다

⚠️ `api-spec.md` 는 10종만 적고 있지만, **실제 코드에는 `INTERNAL_STATE` 가 하나 더 있다**
(server-b 전용). 구현 기준은 각 서버의 `GlobalExceptionHandler.java` 다.

| 코드 | HTTP | 의미 | a | b | c |
|---|---|---|:-:|:-:|:-:|
| `VALIDATION_FAILED` | 400 | 본문 검증 실패 (`fieldErrors` 채움) | ✅ | ✅ | ✅ |
| `MISSING_HEADER` | 400 | 필수 헤더 누락 (`X-User-Id`) | ✅ | ❌ | ✅ |
| `MALFORMED_BODY` | 400 | JSON 파싱 실패 | ✅ | ✅ | ✅ |
| `TYPE_MISMATCH` | 400 | path/query 타입 불일치 | ✅ | ✅ | ✅ |
| `INVALID_ARGUMENT` | 400 | 도메인 인자 검증 실패 (`IllegalArgumentException`) | ✅ | ✅ | ✅ |
| `NOT_FOUND` | 404 | 쿠폰 미존재 **또는 타인 소유 (마스킹)** | — | — | ✅ |
| `EVENT_NOT_FOUND` | 404 | 이벤트 미존재 | — | — | ✅ |
| `INVALID_STATE` | **409** | 상태 전이 실패 (`IllegalStateException`) | ✅ | ❌ | ✅ |
| `INTERNAL_STATE` | **500** | ⚠️ **server-b 전용** — b 는 `IllegalStateException` 을 409 가 아니라 **500 + 이 코드**로 매핑하고 `log.error` 를 남긴다 | ❌ | ✅ | ❌ |
| `RACE_RETRY` | 409 | 낙관락 충돌 — 재시도 안내 | — | — | ✅ |
| `INTERNAL_ERROR` | 500 | 마스킹된 서버 오류 (`message: "internal server error"`) | ✅ | ✅ | ✅ |

**서버별 차이를 지우지 말 것.** b 의 `IllegalStateException` → 500 `INTERNAL_STATE` 는
"내부 API 라 도메인 상태 충돌이 있을 수 없고, 있으면 그건 버그다" 라는 의도다.
a/c 와 통일하고 싶어지면 **바꾸지 말고 사용자에게 질문**한다.

**어떤 예외가 어떤 코드로 가는지도 계약이다.** 특히 Java 의 두 표준 예외를 구분할 것:
- `IllegalArgumentException` (도메인 인자 검증 — `CouponCode` 길이, `must be positive`, `isBlank`)
  → **400 `INVALID_ARGUMENT`**, 예외 메시지를 그대로 노출
- `Objects.requireNonNull` 이 던지는 `NullPointerException` → 매핑 없음 → **500 `INTERNAL_ERROR`** (마스킹)
TS 로 옮길 때 전자는 `InvalidArgumentError`, 후자는 평범한 `Error` 로 둔다. 섞으면 상태코드가 달라진다.

**승인된 예외 2건** (사용자 결정 — 아래 두 가지는 원본과 달라도 된다):
1. **`fieldErrors[].message` 텍스트** — 원본은 Bean Validation 기본 메시지(`"must not be blank"`),
   우리는 class-validator 기본 메시지(`"country should not be empty"`). `field` 경로와 에러 개수는 동일.
   라이브러리 관용구 차이로 인정. 데코레이터마다 `message` 를 지정해 맞추지 않는다.
2. **프레임워크 오류(없는 경로·405·415)** — 원본은 500 `INTERNAL_ERROR` 봉투, 우리는
   상태코드를 유지하고 본문만 봉투로 감싼다 (ADR-N06). 이때의 코드(`NOT_FOUND`,
   `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`)는 **위 11종 계약과 별개 집합**이다.

**메시지 문자열도 계약이다** (원본 그대로):
- `MISSING_HEADER` → `"required header missing: " + headerName`
- `VALIDATION_FAILED` → `"request body validation failed"`
- `MALFORMED_BODY` → `"request body is malformed"`
- `TYPE_MISMATCH` → `"argument type mismatch: " + name` (name = 컨트롤러 파라미터 이름. `X-User-Id` 변환 실패 시 `userId`)
- `NOT_FOUND` → `"coupon not found"` / `EVENT_NOT_FOUND` → `"event not found"`
- `RACE_RETRY` → `"concurrent modification — retry the request"`
- `INTERNAL_ERROR` → `"internal server error"`
- `INVALID_ARGUMENT` / `INVALID_STATE` / `INTERNAL_STATE` → 예외의 `message` 를 그대로 노출

**특수 케이스 — server-a 의 503** (`IssueRequestController` + `RestClientCouponIssuingClient` 확인):

트리거는 "CB OPEN" 만이 아니라 **`downstreamStatus === INTERNAL_ERROR` 전부**다.
응답은 **503 + `Retry-After: 5`**, 본문은 봉투 `success: true` 안에
`{ requestId, status: "INTERNAL_ERROR", message: <아래 4종 중 하나> }`.

| message | 발생 조건 |
|---|---|
| `circuit-open` | Resilience4j `CallNotPermittedException` (CB OPEN) |
| `server-b-status:{code}` | B 가 4xx/5xx 응답 (예: `server-b-status:500`) |
| `downstream-error:{예외SimpleName}` | 그 외 호출 실패 (예: `downstream-error:ResourceAccessException`) |
| `empty-response` | B 가 빈 본문 또는 `status: null` 반환 — **fallback 이 아니라 정상 경로에서 생성** |

⚠️ `"downstream temporarily unavailable"` 같은 문자열은 원본에 **없다**. 위 4종이 전부다.
봉투 `success` 가 true 인 것도 원본 그대로다. 고치지 말 것.

## 5. 요청 본문 — `#1` (10 필드, 순서·이름·제약 고정)

| 필드 | 타입 | 필수 | 제약 |
|---|---|---|---|
| `country` | string | ✅ | NotBlank, max 8 |
| `eventId` | number | ✅ | Positive |
| `couponTypeId` | number | ✅ | Positive |
| `issuedAt` | ISO-8601 | ✅ | — |
| `expireAt` | ISO-8601 | ✅ | — |
| `channel` | string | ✅ | NotBlank, max 32 |
| `deviceId` | string | ⛔ | max 64 |
| `clientVersion` | string | ⛔ | max 32 |
| `language` | string | ⛔ | max 8 |
| `marketingConsent` | boolean | ⛔ | — |

`#5` 요청 본문: `{ eventId: number(Positive), couponTypeId: number(Positive) }` 뿐.

## 6. 상태값 enum — 문자열 그대로

| enum | 값 |
|---|---|
| `IssueAcceptanceStatus` (#1, #5 응답) | `ACCEPTED` / `DUPLICATE` / `SOLD_OUT` / `INTERNAL_ERROR` |
| `IssueRequestStatus` (A DB) | `ACCEPTED` / `DUPLICATE` / `SOLD_OUT` / `REJECTED` |
| `IssuePendingStatus` (B Redis) | `PENDING` / `SUCCESS` / `SOLD_OUT` / `FAILED` |
| `UserCouponStatus` (C DB, #3/#6 응답) | `SUCCESS` / `SOLD_OUT` / `FAILED` / `USED` |
| `CouponIssueResultStatus` (Kafka result) | `SUCCESS` / `SOLD_OUT` / `FAILED` |
| `EventStatus` (#4 응답) | `CREATED` / `IN_PROGRESS` / `ENDED` / `CANCELLED` |
| `OutboxEventStatus` (C DB) | `PENDING` / `PUBLISHED` |

## 7. MySQL — 테이블 / 컬럼 / 제약 이름

원본 `V1__schema.sql`, `V2__add_event_status.sql` 이 권위. 마이그레이션은 그 DDL 을 **문자열 그대로** 옮긴다 (ADR-N05).

- `server_a`: `issue_request` — 인덱스 `idx_issue_request_user`, `idx_issue_request_request_id`
- `server_c`: `event`, `coupon_type`, `coupon_type_inventory`, `user_coupon`, `outbox_event`
- 절대 바뀌면 안 되는 제약 이름:
  `uk_inventory_event_type`, `uk_user_coupon_code`, `uk_user_coupon_user_type`,
  `fk_coupon_type_event`, `fk_inventory_coupon_type`, `fk_user_coupon_coupon_type`
- 인덱스: `idx_event_status`, `idx_coupon_type_event`, `idx_user_coupon_user`, `idx_outbox_status_created`
- 모든 시각 컬럼은 `DATETIME(3)`, 상태 컬럼은 `VARCHAR(20)` (ENUM 아님)

## 8. Redis 키

| 키 | 자료구조 | TTL | 쓰는 쪽 → 읽는 쪽 |
|---|---|---|---|
| `issue:pending:{userId}:{couponTypeId}` | Hash | 86400s | b → b |
| `issue:pending:zset` | ZSet | 없음 | b → b |
| `event:{eventId}` | Hash | 300s | c → c |
| `coupon:available:{eventId}:{couponTypeId}` | String (존재=매진) | 86400s | **c → a** |

pending Hash 필드명: `requestId`, `userId`, `eventId`, `couponTypeId`, `status`, `createdAt`, `code`, `publishAttempts`, `lastPublishedAt`
ZSet member: `"{userId}:{couponTypeId}"`, score: `lastPublishedAt` (최초엔 `createdAt`) epoch ms

## 9. Kafka — 원본 record 로 확정 (2026-09-20 확인)

| 토픽 | 방향 | key | payload 필드 (순서 그대로) |
|---|---|---|---|
| `coupon-issue-request` | b → c | `userId` | `requestId`, `userId`, `eventId`, `couponTypeId`, `requestedAt` |
| `coupon-issue-result` | c → b | **`requestId`** | `requestId`, `userId`, `eventId`, `couponTypeId`, `status`, **`couponCode`**, `processedAt` |

- result 의 코드 필드는 **`couponCode`** 다. `code` 가 아니다 (Redis hash 필드명이 `code` 라서 혼동하기 쉽다).
- `couponCode` 는 `status === 'SUCCESS'` 일 때만 non-null.
- ⚠️ **두 토픽의 key 가 다르다.**
  - request: `IssueRequestPublisher` 가 `Long.toString(payload.userId())` 를 key 로 쓴다
    → 같은 user 의 신청에 partition 순서 보장.
  - result: `OutboxPoller` 가 `outbox_event.aggregate_id` 를 key 로 넘기고,
    `CouponIssueProcessor#saveOutbox` 가 거기에 **`requestId`** 를 넣는다.
  - `CouponIssueResultPayload` 의 javadoc 은 "key = userId" 라고 적혀 있지만 **코드와 다르다**.
    `erd.md` 의 `aggregate_id` 설명("user_coupon_id 등")도 실제와 다르다. 코드가 권위다.
- 시각 필드(`requestedAt`, `processedAt`)는 Java **`Instant`** → `2026-05-10T14:20:00Z` 형태
  (UTC, `Z` 접미사 있음). `LocalDateTime` 필드와 형식이 다르니 §11 과 혼동하지 말 것.

### 쿠폰 코드 생성 규칙 (`CouponCode`)
- 길이 **12**, 알파벳 `ABCDEFGHJKMNPQRSTVWXYZ0123456789` (32자, I/L/O/U 제외)
- 생성 주체는 **server-c** 의 발급 트랜잭션 (원본 주석의 "Server B 발급 시점" 은 구설계 잔재)
- ⚠️ SOLD_OUT / FAILED 일 때는 `CouponCode` 를 거치지 않고
  `"X" + requestId.substring(0, 11)` placeholder 를 `user_coupon.code` 에 직접 넣는다
  (UUID 조각이라 위 알파벳 규칙을 만족하지 않는다 — **의도된 우회**다. VO 검증을 태우지 말 것)

## 10. 포트

| 서비스 | 포트 | 헬스 |
|---|---|---|
| server-a | 8080 | `/actuator/health` → Nest 에서도 **같은 경로**로 노출 |
| server-b | 8081 | 같음 |
| server-c | 8082 | 같음 |

---

## 11. 체크리스트 — 계약을 건드리는 PR 이면 전부 통과해야 함

- [ ] 경로·메서드가 §1/§2 표와 **문자 단위로** 일치하는가
- [ ] 응답 봉투 형태와 `null` 생략 규칙이 §3 과 같은가 (`usedAt` 예외 포함)
- [ ] 반환 HTTP 상태코드가 §4 와 같은가 (특히 404 마스킹, 409 두 종류, 503 + `Retry-After`)
- [ ] DTO 필드 이름/타입/필수 여부가 §5 와 같은가
- [ ] enum 문자열이 §6 과 같은가 (대소문자 포함)
- [ ] 테이블/컬럼/제약/인덱스 이름이 §7 과 같은가
- [ ] Redis 키 문자열·필드명·TTL 이 §8 과 같은가
- [ ] Kafka 토픽명·payload 필드명이 §9 와 같은가
- [ ] **원본에 없는 것을 추가하지 않았는가**

하나라도 "원본을 개선했다" 면 → 되돌리고 사용자에게 보고한다.

## 11. 시각 직렬화 — `Instant` 와 `LocalDateTime` 은 형식이 다르다

원본은 두 가지 시각 타입을 쓰고 Jackson 이 **서로 다른 문자열**로 직렬화한다. 섞으면 계약이 깨진다.

| 타입 | 쓰이는 곳 | 형식 | 예 |
|---|---|---|---|
| `Instant` | Kafka payload (`requestedAt`, `processedAt`), server-a `issue_request.created_at` | ISO-8601 **UTC, `Z` 포함** | `2026-05-10T14:20:00Z` |
| `LocalDateTime` | server-c 의 모든 API 응답 (`issuedAt`, `usedAt`, `startedAt`, `endedAt`) | **`ISO_LOCAL_DATE_TIME` — 타임존 없음** | `2026-05-10T14:20:30.123` |

⚠️ **`ISO_LOCAL_DATE_TIME` 은 뒷자리를 생략한다.** JS `Date.toISOString()` 과 다르다:

| 값 | Java 출력 | `toISOString()` (틀림) |
|---|---|---|
| 14:20:00.000 | `2026-05-10T14:20` | `2026-05-10T14:20:00.000Z` |
| 14:20:30.000 | `2026-05-10T14:20:30` | `2026-05-10T14:20:30.000Z` |
| 14:20:30.123 | `2026-05-10T14:20:30.123` | `2026-05-10T14:20:30.123Z` |

규칙: `HH:mm` 을 쓰고, 초가 0 이 아니거나 밀리초가 0 이 아니면 `:ss` 를 붙이고,
밀리초가 0 이 아니면 `.SSS` 를 붙인다. `Z` 는 **절대 붙이지 않는다**.

`api-spec.md` 의 예시(`"2026-05-10T14:20:00.000"`)는 손으로 쓴 것이라 이 규칙과 어긋난다 — 코드가 권위다.

DB 는 `jdbc.time_zone: UTC` 로 저장하므로 JS 에서는 Date 의 **UTC 성분**으로 포맷해야
저장값이 그대로 나온다 (`libs/common` 의 `toLocalDateTimeString`).
