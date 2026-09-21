/**
 * 요청 로그 상태 (원본 `IssueRequestStatus`).
 *
 * 응답 모델이 즉시 "접수 완료" 라 진행 상태(FORWARDED 등)는 의미가 작다.
 * `SOLD_OUT` 은 매진 negative cache 로 단락된 결과를 감사 로그에 남긴 것이다.
 */
export const ISSUE_REQUEST_STATUSES = [
  'ACCEPTED',
  'DUPLICATE',
  'SOLD_OUT',
  'REJECTED',
] as const;
export type IssueRequestStatus = (typeof ISSUE_REQUEST_STATUSES)[number];
