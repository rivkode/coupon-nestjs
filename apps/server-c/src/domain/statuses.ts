/**
 * server-c 의 도메인 상태값. 문자열 값이 곧 DB 컬럼 값이자 API 응답 값이다 (api-contract §6).
 * 스키마가 `VARCHAR(20)` 이므로 TypeORM `type: 'enum'` 을 쓰지 않는다 (ADR-N05).
 */

export const USER_COUPON_STATUSES = [
  'SUCCESS',
  'SOLD_OUT',
  'FAILED',
  'USED',
] as const;
export type UserCouponStatus = (typeof USER_COUPON_STATUSES)[number];

/**
 * 이벤트 lifecycle 상태.
 *
 * 전이: CREATED → IN_PROGRESS → ENDED. CANCELLED 는 어느 상태에서나 진입 가능.
 *
 * EventCacheRefresher 는 IN_PROGRESS 상태의 이벤트만 백그라운드 갱신 대상으로 삼는다 —
 * 생성/종료/취소 상태는 빈번 조회 트래픽이 없으므로 stampede 위험이 작다.
 */
export const EVENT_STATUSES = [
  'CREATED',
  'IN_PROGRESS',
  'ENDED',
  'CANCELLED',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * Outbox row 의 **메타 상태** — "아직 Kafka 로 안 보냈는가" 만 뜻한다.
 * 발급 결과(SUCCESS/SOLD_OUT/FAILED)는 payload 안에 들어있다.
 */
export const OUTBOX_EVENT_STATUSES = ['PENDING', 'PUBLISHED'] as const;
export type OutboxEventStatus = (typeof OUTBOX_EVENT_STATUSES)[number];
