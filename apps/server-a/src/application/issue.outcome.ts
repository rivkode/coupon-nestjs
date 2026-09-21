import type { IssueAcceptanceStatus } from '@app/common';
import type { IssueRequest } from '../domain/issue-request';

/** 서비스 결과 (원본 `IssueOutcome` record). 컨트롤러가 HTTP status 매핑에 쓴다. */
export class IssueOutcome {
  constructor(
    readonly issueRequest: IssueRequest,
    readonly downstreamStatus: IssueAcceptanceStatus,
    readonly message: string | null,
  ) {}

  /** `INTERNAL_ERROR` 면 503 + `Retry-After` 로 응답한다 (api-contract §1). */
  isDownstreamUnavailable(): boolean {
    return this.downstreamStatus === 'INTERNAL_ERROR';
  }
}
