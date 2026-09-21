# 시스템 아키텍처

## 📚 문서 목록

- **시스템 아키텍처** ← 현재 문서
- [ERD / 데이터 모델](erd.md)
- [API 명세](api-spec.md)
- [기술 결정 기록](../decisions/README.md)

[← README](../../README.md)

---

## 요구사항 요약

| 항목 | 값 |
|---|---|
| 시나리오 | 이벤트별 선착순 할인 쿠폰 발급 및 사용 |
| 규모 | 이벤트 100개 × 이벤트당 쿠폰 100장, 사용자 1,000명 |
| 목표 처리량 | **1,000 TPS** (1,000명 × 10건 / 10초) |
| 응답 시간 | 2초 이내 |
| 서버 사양 | vCPU 1, RAM 2GB (서버당) |
| 제약 | 사용자는 이벤트당 1장만 발급 가능 |

재고보다 요청이 훨씬 많아 **매진이 반드시 발생**하고, 요청의 대부분이 매진 이후에 도착한다.
이 전제가 설계 곳곳에 반영되어 있다 (매진 negative cache, 진입부 단락).

---

## 서비스 구성

```
[User] ──HTTPS──▶ [server-a] ──sync HTTP──▶ [server-b] ──Kafka(issue)──▶ [server-c]
                  진입/검증/요청 로그        신청 적재/접수 응답          재고 차감/영구 저장
                       │                          │   ▲                       │
                    [MySQL-A]                  [Redis] │                   [MySQL-C]
                  issue_request               pending  │ Kafka(result)       event
                  (감사 로그)                  event cache ◀────────────── coupon_type
                                                                            coupon_type_inventory
                                                                            user_coupon
                                                                            outbox_event
```

| 서비스 | 책임 | 저장소 | 하지 않는 것 |
|---|---|---|---|
| **A** (:8080) | 진입, `X-User-Id` 인증, 매진 단락, 요청 로그, B 호출 | MySQL-A + Redis(읽기) | 재고 관리, 긴 트랜잭션 |
| **B** (:8081) | Redis 적재 → 즉시 접수 응답 → Kafka 발행 → 결과 캐시 → 보완 스케줄러 | **Redis only** | 재고 관리, DB 사용 |
| **C** (:8082) | 영구 저장, 재고 권위(비관적 락), Outbox, 쿠폰 사용, 이벤트 캐시 | MySQL-C + Redis | 트랜잭션 내 외부 호출 |

**A→B 는 동기이되 응답은 "접수 완료"**, **B↔C 는 양방향 비동기 Kafka** 가 핵심이다.
사용자 응답 지연과 재고 락 경합을 분리하기 위한 구조다.

저장소는 서비스별로 분리한다 (Database per Service). 서비스 간 물리 FK 는 없다.

---

## 발급 흐름

### 정상 경로

| # | 위치 | 동작 |
|---|---|---|
| 1 | A | Redis negative cache 확인 → 매진이면 **즉시 SOLD_OUT** (B 호출 안 함) |
| 2 | A → B | `POST /internal/v1/coupons/issue` (Circuit Breaker 적용) |
| 3 | B | `HSETNX` 로 중복 판정 → pending hash + ZSet 적재 |
| 4 | A | `issue_request` 에 요청 로그 기록 (감사용) |
| 5 | B | Kafka `coupon-issue-request` 발행 → **즉시 "접수 완료" 응답** |
| 6 | C | consume (throttle: 한 번에 10건, concurrency 1) |
| 7 | C | **1 트랜잭션**: 중복 체크 → 이벤트 유효성 → 재고 비관락 차감 → `user_coupon` INSERT → `outbox_event` INSERT |
| 8 | C | 커밋 직후 재고 fresh read → 0 이면 매진 캐시 SET |
| 9 | C | Outbox poller(500ms)가 PENDING 조회 |
| 10 | C | Kafka `coupon-issue-result` 발행 → PUBLISHED 갱신 |
| 11 | B | consume → Redis 상태 갱신(SUCCESS/SOLD_OUT/FAILED) + ZSet 제거 |

사용자는 5단계에서 "접수 완료"를 받고, 결과는 조회로 확인한다.

### 회복 경로 (보완 스케줄러)

Redis 적재와 Kafka 발행은 원자적이지 않다. 발행이 유실되면 신청이 PENDING 에 머문다.
B 의 스케줄러(1초 주기)가 10초 초과 PENDING 을 찾아 **30초 안에 결론**을 낸다.

자세한 내용은 [분산 정합성](../reports/consistency.md) 참조.

---

## 쿠폰 사용 / 조회

| 흐름 | 동작 |
|---|---|
| 쿠폰 사용 | C 가 `code` 로 조회 → 소유권 검증(타인은 404 마스킹) → 조건부 UPDATE 로 USED 전이 |
| 내 쿠폰 목록 | C 가 `user_id` 인덱스로 조회, `issued_at DESC` |
| 이벤트 조회 | C 가 Redis 캐시 확인 → miss 면 DB → 캐시 적재 |

---

## 핵심 설계 포인트

| 관심사 | 선택 | 근거 문서 |
|---|---|---|
| 대량 트래픽 | 진입 단순화 + 발급 비동기화 | [Node 런타임 제약](../reports/runtime.md) |
| 동시성 | 재고는 비관적 락, 사용은 낙관적 락 | [동시성 제어](../reports/concurrency.md) |
| 정합성 | Outbox + UNIQUE 멱등 + 보완 스케줄러 | [분산 정합성](../reports/consistency.md) |
| Hot Key | Refresh-Ahead + 매진 negative cache | [캐시 전략](../reports/cache.md) |
| 유량 제어 | Kafka consumer throttle | [Kafka](../reports/kafka.md) |
