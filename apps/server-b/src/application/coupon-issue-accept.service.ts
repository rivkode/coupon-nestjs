import {
  IssueAcceptance,
  toInstantString,
  type CouponIssueRequestPayload,
  type IssueAcceptanceResult,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PendingIssueStore } from '../domain/pending-issue.store';
import { IssueRequestPublisher } from '../infrastructure/kafka/issue-request.publisher';

/**
 * 발급 신청 접수 (원본 `CouponIssueAcceptService`). ADR-001 — 즉시 "접수 완료" 응답.
 *
 *  1. Redis 에 `(user, couponType)` 중복 체크 → 있으면 DUPLICATE
 *  2. 없으면 pending hash + zset 등록 (`publishAttempts=1` 포함)
 *  3. Kafka publish (idempotent producer + retries — ADR-008)
 *  4. ACCEPTED 응답
 *
 * SOLD_OUT 단락은 **server-a 진입**에서 처리한다 (ADR-011). b 까지 도달한 요청은 매진 캐시가
 * 없거나 Redis blip 으로 fall-through 한 것 — 정상 흐름을 그대로 진행하면 c 의 비관적 락 +
 * UNIQUE 가 정합성을 보장한다.
 *
 * ⚠️ **publish 실패를 삼킨다 (항상 ACCEPTED).** Redis 적재가 "처리 의도 커밋" 의 진실이고,
 *    30s 안에 스케줄러가 재발행으로 회복하므로(ADR-008), 사용자에게 5xx 를 돌려
 *    DUPLICATE 재시도 흐름을 만드는 것보다 ACCEPTED 응답이 일관된다.
 *    사용자는 폴링/내쿠폰 조회로 최종 결과를 확인한다.
 */
@Injectable()
export class CouponIssueAcceptService {
  private readonly logger = new Logger(CouponIssueAcceptService.name);

  constructor(
    private readonly store: PendingIssueStore,
    private readonly publisher: IssueRequestPublisher,
  ) {}

  async accept(
    userId: number,
    eventId: number,
    couponTypeId: number,
  ): Promise<IssueAcceptanceResult> {
    const requestId = randomUUID();
    const now = new Date();

    const firstWrite = await this.store.savePendingIfAbsent({
      requestId,
      userId,
      eventId,
      couponTypeId,
      createdAt: now,
    });
    if (!firstWrite) {
      this.logger.log(
        `duplicate request: userId=${userId}, couponTypeId=${couponTypeId}`,
      );
      return IssueAcceptance.duplicate(requestId);
    }

    const payload: CouponIssueRequestPayload = {
      requestId,
      userId,
      eventId,
      couponTypeId,
      requestedAt: toInstantString(now),
    };

    try {
      await this.publisher.publish(payload);
    } catch (e) {
      // Redis 는 attempts=1 로 적재됨 → 10s 후 스케줄러가 집어 재발행. cap 안에서 회복된다.
      this.logger.warn(
        `initial publish failed — scheduler will retry within SLA: requestId=${requestId}, ` +
          `userId=${userId}, couponTypeId=${couponTypeId} reason=${String(e)}`,
      );
    }

    this.logger.log(
      `accepted: requestId=${requestId}, userId=${userId}, couponTypeId=${couponTypeId}`,
    );
    return IssueAcceptance.accepted(requestId);
  }
}
