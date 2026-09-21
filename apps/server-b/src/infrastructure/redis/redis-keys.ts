/**
 * server-b 의 Redis 키 컨벤션 (원본 `RedisKeys`). 키 문자열은 계약이다 (api-contract §8).
 */
export const RedisKeys = {
  /** 사용자 신청 hash — status / createdAt / requestId / eventId / couponTypeId / code / publishAttempts / lastPublishedAt */
  pendingHash(userId: number, couponTypeId: number): string {
    return `issue:pending:${userId}:${couponTypeId}`;
  },

  /** member = `"{userId}:{couponTypeId}"`, score = lastPublishedAt(최초엔 createdAt) epoch ms */
  PENDING_ZSET: 'issue:pending:zset',

  pendingZsetMember(userId: number, couponTypeId: number): string {
    return `${userId}:${couponTypeId}`;
  },
} as const;
