# API 명세

## 📚 문서 목록

- [시스템 아키텍처](architecture.md)
- [ERD / 데이터 모델](erd.md)
- **API 명세** ← 현재 문서
- [기술 결정 기록](../decisions/README.md)

[← README](../../README.md)

---

## 0. 공통

### 인증

`X-User-Id` 헤더로 사용자를 식별한다. 운영에서는 상위 게이트웨이가 JWT 를 검증한 뒤
user_id 를 헤더로 전달하는 모델을 가정한다.

### 응답 봉투

```jsonc
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "...", "message": "...", "fieldErrors": [ ... ] } }
```

`null` 필드는 직렬화에서 생략한다.
**예외**: 내 쿠폰 목록의 `usedAt` 은 null 이어도 생략하지 않는다 ("아직 안 썼다"가 의미 있는 정보).

내부 API `POST /internal/v1/coupons/issue` 만 봉투 없이 raw payload 로 응답한다.

### 에러 코드

| 코드 | HTTP | 의미 | a | b | c |
|---|---|---|:-:|:-:|:-:|
| `VALIDATION_FAILED` | 400 | 본문 검증 실패 (`fieldErrors` 포함) | ✅ | ✅ | ✅ |
| `MISSING_HEADER` | 400 | 필수 헤더 누락 | ✅ | ❌ | ✅ |
| `MALFORMED_BODY` | 400 | JSON 파싱 실패 | ✅ | ✅ | ✅ |
| `TYPE_MISMATCH` | 400 | path/query 타입 불일치 | ✅ | ✅ | ✅ |
| `INVALID_ARGUMENT` | 400 | 도메인 인자 검증 실패 | ✅ | ✅ | ✅ |
| `NOT_FOUND` | 404 | 쿠폰 미존재 또는 **타인 소유(마스킹)** | — | — | ✅ |
| `EVENT_NOT_FOUND` | 404 | 이벤트 미존재 | — | — | ✅ |
| `INVALID_STATE` | 409 | 상태 전이 실패 | ✅ | ❌ | ✅ |
| `INTERNAL_STATE` | 500 | **b 전용** — b 는 상태 충돌을 버그로 본다 | ❌ | ✅ | ❌ |
| `RACE_RETRY` | 409 | 낙관적 락 충돌 — 재시도 가능 | — | — | ✅ |
| `INTERNAL_ERROR` | 500 | 마스킹된 서버 오류 | ✅ | ✅ | ✅ |

> b 는 내부 API 만 제공하므로 도메인 상태 충돌이 있을 수 없고, 있으면 버그로 본다.
> 같은 이유로 헤더 누락도 400 이 아니라 500 이다.

프레임워크 오류(없는 경로·405·415)는 상태코드를 유지하되 본문만 봉투로 감싼다.
이때의 코드는 위 표와 별개 집합이다.

---

## 1. 쿠폰 발급 요청

`POST /api/v1/coupons/issue-request` · server-a · `X-User-Id` 필수 · **200**

발급을 접수하고 즉시 응답한다. 실제 발급은 비동기로 처리되므로 결과는 조회로 확인한다.

**요청 본문** (10 필드)

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

**응답**

```json
{ "success": true, "data": { "requestId": "1f6b0c9a-...", "status": "ACCEPTED" } }
```

| `status` | 의미 |
|---|---|
| `ACCEPTED` | 접수됨. 결과는 조회로 확인 |
| `DUPLICATE` | 같은 `(user, couponType)` 이 이미 신청/발급됨 |
| `SOLD_OUT` | 매진 캐시에서 단락 |

**503 + `Retry-After: 5`** — Circuit Breaker OPEN 또는 B 일시 장애.
봉투는 `success: true` 이고 `data.status` 가 `INTERNAL_ERROR` 다. `message` 는 실패 사유를 담는다
(`circuit-open`, `server-b-status:{code}`, `downstream-error:{예외명}`, `empty-response`).

---

## 2. 쿠폰 사용

`POST /api/v1/coupons/{code}/redeem` · server-c · `X-User-Id` 필수 · **200**

```json
{
  "success": true,
  "data": { "code": "CPN7F3A2BXY", "userId": 123456, "redeemedAt": "2026-05-10T14:23:11.123", "newlyRedeemed": true }
}
```

| 필드 | 의미 |
|---|---|
| `newlyRedeemed: true` | 이번 호출에서 USED 로 전이 |
| `newlyRedeemed: false` | 같은 사용자의 멱등 재호출. `redeemedAt` 은 **최초 사용 시각** |

| HTTP | code | 시나리오 |
|---|---|---|
| 404 | `NOT_FOUND` | 코드 미존재 **또는 타인 소유** (구분하지 않는다) |
| 409 | `INVALID_STATE` | 사용 불가 상태 (발급이 SOLD_OUT / FAILED) |
| 409 | `RACE_RETRY` | 낙관적 락 충돌 — 즉시 재시도 가능 |

---

## 3. 내 쿠폰 목록

`GET /api/v1/users/me/coupons` · server-c · `X-User-Id` 필수 · **200**

`issued_at DESC` 정렬. 페이지네이션 없음 (사용자당 이벤트 상한이 100 이라 응답 크기가 작다).

```json
{
  "success": true,
  "data": [
    { "userId": 123456, "eventId": 202605, "couponTypeId": 1, "code": "CPN7F3A2BXY",
      "status": "USED", "issuedAt": "2026-05-10T14:20", "usedAt": "2026-05-10T14:23:11.123" }
  ]
}
```

`status` 는 `SUCCESS / SOLD_OUT / FAILED / USED`.

---

## 4. 이벤트 조회

`GET /api/v1/events/{eventId}` · server-c · **인증 없음** · **200**

```json
{
  "success": true,
  "data": { "eventId": 202605, "name": "5월 이벤트", "content": "최대 30% 할인",
            "startedAt": "2026-05-01T00:00", "endedAt": "2026-05-31T23:59:59", "status": "IN_PROGRESS" }
}
```

`status` 는 `CREATED / IN_PROGRESS / ENDED / CANCELLED`. `content` 가 null 이면 키가 생략된다.

| HTTP | code |
|---|---|
| 400 | `TYPE_MISMATCH` — eventId 가 숫자가 아님 |
| 404 | `EVENT_NOT_FOUND` |

---

## 5. 내부 API

서비스 간 통신용. 외부에서 직접 호출하지 않는다.

### 5.1 발급 접수 (A → B)

`POST /internal/v1/coupons/issue` · server-b · `X-User-Id` 필수 · **200**

요청: `{ "eventId": 202605, "couponTypeId": 1 }`

**봉투 없이** raw 응답:

```json
{ "requestId": "1f6b0c9a-...", "status": "ACCEPTED" }
```

`status` ∈ `ACCEPTED / DUPLICATE / SOLD_OUT / INTERNAL_ERROR`.
A 가 이 응답을 자기 봉투로 감싸 사용자에게 전달한다.

### 5.2 사용자 쿠폰 단건 조회 (B → C)

`GET /internal/v1/users/{userId}/coupons/{couponTypeId}` · server-c · **200**

B 의 보완 스케줄러가 10초 초과 PENDING 신청에 대해 호출한다. **봉투를 사용한다.**

미처리 상태면 404 `NOT_FOUND` — 스케줄러는 이것을 "아직 처리 전"이라는 **정상 신호**로 읽고
재발행 단계로 넘어간다.

---

## 6. 시각 표기

두 종류가 섞여 있고 형식이 다르다.

| 위치 | 형식 | 예 |
|---|---|---|
| Kafka payload (`requestedAt`, `processedAt`) | UTC, `Z` 포함 | `2026-05-10T14:20:00Z` |
| API 응답 (`issuedAt`, `usedAt`, `startedAt`, `endedAt`) | **타임존 없음** | `2026-05-10T14:20:30.123` |

API 응답 형식은 뒷자리를 생략한다. `14:20:00.000` → `2026-05-10T14:20`.
`Date.prototype.toISOString()` 을 그대로 쓰면 안 된다 (항상 `.000Z` 가 붙는다).

---

## 7. 포트 / 헬스체크

| 서비스 | 포트 | 엔드포인트 |
|---|---|---|
| server-a | 8080 | `/actuator/health` |
| server-b | 8081 | `/actuator/health`, `/actuator/prometheus` |
| server-c | 8082 | `/actuator/health` |
