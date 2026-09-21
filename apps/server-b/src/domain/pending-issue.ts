import type { IssuePendingStatus } from './statuses';

/**
 * Redis hash 의 의미적 표현 (원본 `PendingIssue` record). `PendingIssueScheduler` 가 사용한다.
 *
 * `publishAttempts` 는 ADR-008 의 재발행 cap 추적용이다 —
 * 최초 accept 시 1, 스케줄러가 재발행할 때마다 증가.
 * cutoff(10s) × max(3) = **30초 안에 SUCCESS 또는 FAILED 로 결론**이 나는 것이 SLA 다.
 */
export interface PendingIssue {
  requestId: string;
  userId: number;
  eventId: number;
  couponTypeId: number;
  status: IssuePendingStatus;
  createdAt: Date;
  publishAttempts: number;
}
