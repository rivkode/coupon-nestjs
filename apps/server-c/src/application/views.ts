import {
  toLocalDateTimeString,
  toLocalDateTimeStringOrNull,
} from '@app/common';
import type { Event } from '../domain/event';
import type { EventStatus, UserCouponStatus } from '../domain/statuses';
import type { UserCoupon } from '../domain/user-coupon';

/**
 * 읽기 모델 = API 응답 본문 = Redis 캐시 직렬화 형.
 *
 * 세 용도의 형태가 **같아야** 한다 (원본도 `EventResponse` 하나를 응답과 캐시에 같이 썼다).
 * `api/` 가 아니라 여기에 두는 이유: `infrastructure/redis` 도 이 타입을 쓰는데
 * infrastructure → api 방향 import 는 레이어 규칙 위반이다 (nest-ddd-layering §1).
 *
 * ⚠️ 시각 필드는 전부 **문자열**이다. Java `LocalDateTime` 의 Jackson 출력을 재현해야 해서
 *    `Date` 를 그대로 두면 `toISOString()` 이 `Z` 와 `.000` 을 붙여 계약이 깨진다 (spec-parity §11).
 */

/** `GET /api/v1/events/{eventId}` 응답 + `event:{id}` 캐시 값 (원본 `EventResponse`). */
export interface EventView {
  eventId: number;
  name: string;
  /** null 이면 직렬화에서 생략된다 (원본 `@JsonInclude(NON_NULL)`). */
  content?: string;
  startedAt: string;
  endedAt: string;
  status: EventStatus;
}

export function toEventView(event: Event): EventView {
  return {
    eventId: event.id,
    name: event.name,
    ...(event.content === null ? {} : { content: event.content }),
    startedAt: toLocalDateTimeString(event.startedAt),
    endedAt: toLocalDateTimeString(event.endedAt),
    status: event.status,
  };
}

/**
 * `GET /api/v1/users/me/coupons` 의 배열 원소 (원본 `UserCouponResponse`).
 *
 * ⚠️ `usedAt` 은 **null 이어도 생략하지 않는다** — "아직 안 썼다" 가 의미 있는 정보라
 *    원본만 `@JsonInclude` 를 붙이지 않았다 (spec-parity §3).
 */
export interface UserCouponView {
  userId: number;
  eventId: number;
  couponTypeId: number;
  code: string;
  status: UserCouponStatus;
  issuedAt: string;
  usedAt: string | null;
}

export function toUserCouponView(coupon: UserCoupon): UserCouponView {
  return {
    userId: coupon.userId,
    eventId: coupon.eventId,
    couponTypeId: coupon.couponTypeId,
    code: coupon.code,
    status: coupon.status,
    issuedAt: toLocalDateTimeString(coupon.issuedAt),
    usedAt: toLocalDateTimeStringOrNull(coupon.usedAt),
  };
}

/**
 * `GET /internal/v1/users/{userId}/coupons/{couponTypeId}` 응답 (원본 `UserCouponInternalResponse`).
 * 이쪽은 `usedAt` 이 없고 `@JsonInclude(NON_NULL)` 이 붙어 있다.
 */
export interface UserCouponInternalView {
  userId: number;
  eventId: number;
  couponTypeId: number;
  code: string;
  status: UserCouponStatus;
  issuedAt: string;
}

export function toUserCouponInternalView(
  coupon: UserCoupon,
): UserCouponInternalView {
  return {
    userId: coupon.userId,
    eventId: coupon.eventId,
    couponTypeId: coupon.couponTypeId,
    code: coupon.code,
    status: coupon.status,
    issuedAt: toLocalDateTimeString(coupon.issuedAt),
  };
}
