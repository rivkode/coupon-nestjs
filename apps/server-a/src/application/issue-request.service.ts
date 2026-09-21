import type { IssueAcceptanceStatus } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { IssueRequest } from '../domain/issue-request';
import { IssueRequestRepository } from '../domain/issue-request.repository';
import type { IssueRequestStatus } from '../domain/statuses';
import { CouponAvailabilityCache } from '../infrastructure/redis/coupon-availability.cache';
import { CouponIssuingClient } from './coupon-issuing.client';
import type { IssueCommand } from './issue.command';
import { IssueOutcome } from './issue.outcome';

/**
 * 발급 요청 처리 (원본 `IssueRequestService`).
 *
 *  1. 매진 negative cache 확인 → 매진이면 **B 호출 없이 즉시 단락**
 *  2. server-b 호출 (Circuit Breaker + Retry)
 *  3. 응답 상태에 따라 요청 로그 status 결정
 *  4. 요청당 한 번 커밋 (감사 로그)
 *
 * ⚠️ **트랜잭션을 열지 않는다.** 경로마다 쓰기가 `save()` 한 번뿐이라 함께 커밋할 두 번째 쓰기가 없고,
 *    save 앞의 B 호출은 이미 B 의 Redis 적재 + Kafka 발행을 끝낸 상태라 롤백으로 되돌릴 수 없다.
 *    트랜잭션을 열면 외부 HTTP 왕복이 그 안에 들어가기만 한다.
 *
 * ⚠️ **매진 확인이 B 호출보다 먼저**다. 순서를 바꾸면 단락의 의미가 사라진다.
 */
@Injectable()
export class IssueRequestService {
  private readonly logger = new Logger(IssueRequestService.name);

  constructor(
    private readonly repository: IssueRequestRepository,
    private readonly client: CouponIssuingClient,
    private readonly availabilityCache: CouponAvailabilityCache,
  ) {}

  async issue(command: IssueCommand): Promise<IssueOutcome> {
    if (
      await this.availabilityCache.isSoldOut(
        command.eventId,
        command.couponTypeId,
      )
    ) {
      const request = await this.save(command, 'SOLD_OUT');
      this.logger.log(
        `short-circuit sold out at A (cache hit): requestId=${request.requestId}, ` +
          `userId=${command.userId}, couponTypeId=${command.couponTypeId}`,
      );
      return new IssueOutcome(request, 'SOLD_OUT', 'coupon sold out');
    }

    const result = await this.client.issue(
      command.userId,
      command.eventId,
      command.couponTypeId,
    );
    const request = await this.save(command, mapStatus(result.status));
    this.logger.log(
      `issue accepted: requestId=${request.requestId}, userId=${command.userId}, ` +
        `couponTypeId=${command.couponTypeId}, status=${result.status}`,
    );
    return new IssueOutcome(request, result.status, result.message);
  }

  private async save(
    command: IssueCommand,
    status: IssueRequestStatus,
  ): Promise<IssueRequest> {
    return this.repository.save(
      IssueRequest.of({
        userId: command.userId,
        eventId: command.eventId,
        couponTypeId: command.couponTypeId,
        status,
        now: new Date(),
      }),
    );
  }
}

/** B 의 응답 상태를 감사 로그 상태로. `INTERNAL_ERROR` 만 `REJECTED` 로 기록한다. */
function mapStatus(status: IssueAcceptanceStatus): IssueRequestStatus {
  switch (status) {
    case 'ACCEPTED':
      return 'ACCEPTED';
    case 'DUPLICATE':
      return 'DUPLICATE';
    case 'SOLD_OUT':
      return 'SOLD_OUT';
    case 'INTERNAL_ERROR':
      return 'REJECTED';
    default: {
      const exhaustive: never = status;
      throw new Error(`unknown acceptance status: ${String(exhaustive)}`);
    }
  }
}
