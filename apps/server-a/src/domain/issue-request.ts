import { randomUUID } from 'node:crypto';
import type { IssueRequestStatus } from './statuses';

/**
 * 요청 로그 (원본 `IssueRequest`). 감사·추적용이며 **발급 결과의 권위가 아니다**
 * — 권위는 server-c 의 `user_coupon` 이다.
 *
 * `status` 는 A 가 B 에게 위임한 결과(ACCEPTED / DUPLICATE / SOLD_OUT / REJECTED)를 담는다.
 */
export class IssueRequest {
  private constructor(
    readonly id: number | null,
    readonly requestId: string,
    readonly userId: number,
    readonly eventId: number,
    readonly couponTypeId: number,
    readonly status: IssueRequestStatus,
    readonly createdAt: Date,
  ) {}

  static of(params: {
    userId: number;
    eventId: number;
    couponTypeId: number;
    status: IssueRequestStatus;
    now: Date;
  }): IssueRequest {
    return new IssueRequest(
      null,
      randomUUID(),
      params.userId,
      params.eventId,
      params.couponTypeId,
      params.status,
      params.now,
    );
  }

  /** DB 에서 복원 (매퍼 전용). */
  static reconstitute(params: {
    id: number;
    requestId: string;
    userId: number;
    eventId: number;
    couponTypeId: number;
    status: IssueRequestStatus;
    createdAt: Date;
  }): IssueRequest {
    return new IssueRequest(
      params.id,
      params.requestId,
      params.userId,
      params.eventId,
      params.couponTypeId,
      params.status,
      params.createdAt,
    );
  }
}
