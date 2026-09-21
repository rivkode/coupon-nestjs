/**
 * Redis 에 적재되는 사용자 신청 상태 (원본 `IssuePendingStatus`).
 * server-c 의 `UserCouponStatus` 와는 **별개의 wire-level enum** 이다 (spec-parity §6).
 */
export const ISSUE_PENDING_STATUSES = [
  'PENDING',
  'SUCCESS',
  'SOLD_OUT',
  'FAILED',
] as const;
export type IssuePendingStatus = (typeof ISSUE_PENDING_STATUSES)[number];
