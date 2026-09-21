import type { IssueAcceptanceResult, IssueAcceptanceStatus } from '@app/common';

/**
 * server-a 가 받는 internal 발급 응답 본문 (원본 `IssueResponse` record).
 *
 * ⚠️ 원본에 `@JsonInclude(NON_NULL)` 이 붙어 있어 **null 필드는 키 자체가 나가지 않는다**.
 *    - `ACCEPTED` → `{ requestId, status }` (message 없음)
 *    - `DUPLICATE` → `{ requestId, status, message }`
 *    - `SOLD_OUT` / `INTERNAL_ERROR` → `{ status, message }` (requestId 없음)
 *
 *    `IssueAcceptanceResult` 를 그대로 반환하면 `"message": null` 이 실려 wire 가 달라진다.
 */
export interface IssueResponseView {
  requestId?: string;
  status: IssueAcceptanceStatus;
  message?: string;
}

export function toIssueResponse(
  result: IssueAcceptanceResult,
): IssueResponseView {
  return {
    ...(result.requestId === null ? {} : { requestId: result.requestId }),
    status: result.status,
    ...(result.message === null ? {} : { message: result.message }),
  };
}
