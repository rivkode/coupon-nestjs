import type { IssueAcceptanceStatus } from '@app/common';
import type { IssueOutcome } from '../application/issue.outcome';

/**
 * 발급 요청 응답 (원본 `IssueCouponResponse`).
 *
 * ⚠️ null 필드는 키 자체가 나가지 않는다 — `ACCEPTED` 응답에는 `message` 가 없다.
 *    `requestId` 는 항상 있다 (A 가 어떤 경로에서도 요청 로그를 남기기 때문).
 */
export interface IssueCouponView {
  requestId: string;
  status: IssueAcceptanceStatus;
  message?: string;
}

export function toIssueCouponView(outcome: IssueOutcome): IssueCouponView {
  return {
    requestId: outcome.issueRequest.requestId,
    status: outcome.downstreamStatus,
    ...(outcome.message === null ? {} : { message: outcome.message }),
  };
}
