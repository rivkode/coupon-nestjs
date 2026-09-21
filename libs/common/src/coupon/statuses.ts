/**
 * wire-level 상태 enum 모음.
 *
 * Java 원본은 각각 별도 enum 파일 (`IssueAcceptanceStatus`, `CouponIssueResultStatus`).
 * TS 에서는 union type + const 배열로 표현한다 — 값 문자열은 원본과 동일해야 한다 (api-contract §6).
 */

/** A↔B 응답 상태. 신규 설계의 응답 모델은 즉시 "접수 완료" 만. */
export const ISSUE_ACCEPTANCE_STATUSES = [
  'ACCEPTED',
  'DUPLICATE',
  /** ADR-011 — negative cache 가 매진을 즉시 단락한 결과. 사용자는 폴링 없이 SOLD_OUT 확정. */
  'SOLD_OUT',
  'INTERNAL_ERROR',
] as const;
export type IssueAcceptanceStatus = (typeof ISSUE_ACCEPTANCE_STATUSES)[number];

/** C → B 의 발급 결과 상태. (server-c 의 UserCouponStatus 와 별개의 wire-level enum) */
export const COUPON_ISSUE_RESULT_STATUSES = [
  'SUCCESS',
  'SOLD_OUT',
  'FAILED',
] as const;
export type CouponIssueResultStatus =
  (typeof COUPON_ISSUE_RESULT_STATUSES)[number];
