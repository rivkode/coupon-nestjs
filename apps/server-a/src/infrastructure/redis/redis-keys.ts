/**
 * server-a 의 Redis 키 (원본 `RedisKeys`). b / c 와 같은 포맷을 공유한다.
 */
export const RedisKeys = {
  /**
   * `coupon:available:{eventId}:{couponTypeId}` — 매진 negative cache.
   *
   * 키 존재 = 매진. **server-c 가 SET 하고 server-a 가 GET 한다** —
   * 이름이 곧 두 서비스 사이의 계약이라 바꾸면 단락이 조용히 죽는다 (api-contract §8).
   */
  couponAvailable(eventId: number, couponTypeId: number): string {
    return `coupon:available:${eventId}:${couponTypeId}`;
  },
} as const;
