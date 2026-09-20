/**
 * server-c 의 Redis 키 컨벤션 (원본 `RedisKeys`).
 * 키 문자열은 계약이다 — `coupon:available:*` 은 **server-a 가 읽는다** (spec-parity §8).
 */
export const RedisKeys = {
  /** `event:{eventId}` — JSON 직렬화된 EventView, TTL 적용. c 가 쓰고 c 가 읽는다. */
  event(eventId: number): string {
    return `event:${eventId}`;
  },

  /**
   * `coupon:available:{eventId}:{couponTypeId}` — ADR-011 SOLD_OUT negative cache.
   * 키 존재 = 매진. 부재 = 사용 가능 또는 미정 (a 가 fall-through). 값 자체는 사용하지 않음.
   * **c 가 쓰고 a 가 읽는다** — 이름을 바꾸면 server-a 의 단락이 조용히 죽는다.
   */
  couponAvailable(eventId: number, couponTypeId: number): string {
    return `coupon:available:${eventId}:${couponTypeId}`;
  },
} as const;
