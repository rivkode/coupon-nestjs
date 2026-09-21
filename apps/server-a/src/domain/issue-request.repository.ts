import type { IssueRequest } from './issue-request';

/**
 * 요청 로그 리포지토리 (원본 `IssueRequestRepository`).
 *
 * 쓰기가 요청당 `save()` 한 번뿐이라 트랜잭션 컨텍스트를 받지 않는다 —
 * 함께 커밋할 두 번째 쓰기가 없다.
 */
export abstract class IssueRequestRepository {
  abstract save(request: IssueRequest): Promise<IssueRequest>;
}
