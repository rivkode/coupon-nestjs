import {
  CouponCode,
  toInstantString,
  type CouponIssueRequestPayload,
  type CouponIssueResultPayload,
  type CouponIssueResultStatus,
  type TxContext,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CouponTypeInventoryRepository } from '../domain/coupon-type-inventory.repository';
import { EventRepository } from '../domain/event.repository';
import { DuplicateUserCouponError } from '../domain/exception/duplicate-user-coupon.error';
import { EVENT_TYPE_ISSUE_RESULT } from '../domain/outbox-event';
import { OutboxEventRepository } from '../domain/outbox-event.repository';
import type { UserCouponStatus } from '../domain/statuses';
import { UserCoupon } from '../domain/user-coupon';
import { UserCouponRepository } from '../domain/user-coupon.repository';
import { CouponAvailabilityCache } from '../infrastructure/redis/coupon-availability.cache';

/**
 * Kafka consumer 가 호출하는 발급 처리 트랜잭션 (ADR-002 / ADR-003).
 *
 * 1 트랜잭션 안에서 **이 순서 그대로**:
 *  1. `(user_id, coupon_type_id)` 중복 체크 (UNIQUE 가 권위 — 본 체크는 빠른 단락)
 *  2. event 유효성 (`started_at ≤ now ≤ ended_at`)
 *  3. `coupon_type_inventory` 비관적 락 차감 (`SELECT ... FOR UPDATE`)
 *  4. `user_coupon` INSERT (SUCCESS / SOLD_OUT / FAILED)
 *  5. `outbox_event` INSERT (결과 publish 용)
 *
 * Kafka publish 는 **트랜잭션 밖** — `OutboxPoller` 가 별도로 한다.
 *
 * ADR-011 의 매진 캐시 적재는 Spring 의 `afterCommit` 훅에 해당하는데 TypeORM 에는 등가물이 없어
 * `dataSource.transaction()` 이 resolve 된 **이후 줄**에서 실행한다 (ADR-N01). 의미는 동일하다.
 */
@Injectable()
export class CouponIssueProcessor {
  private readonly logger = new Logger(CouponIssueProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly userCouponRepository: UserCouponRepository,
    private readonly inventoryRepository: CouponTypeInventoryRepository,
    private readonly eventRepository: EventRepository,
    private readonly outboxRepository: OutboxEventRepository,
    private readonly availabilityCache: CouponAvailabilityCache,
  ) {}

  async process(request: CouponIssueRequestPayload): Promise<void> {
    // 커밋 후에 매진 캐시를 볼지 여부. 트랜잭션 안에서 결정하면 롤백 시 ghost write 가 생긴다.
    let checkAvailability = false;

    try {
      await this.runIssueTransaction(request, () => {
        checkAvailability = true;
      });
    } catch (e) {
      if (e instanceof DuplicateUserCouponError) {
        // 1번 단락을 통과한 뒤 동시 요청이 먼저 INSERT 한 경우. UNIQUE 가 권위이므로 멱등 종료.
        //
        // ⚠️ 여기서 **트랜잭션은 이미 롤백됐다** — 재고 차감도 함께 되돌아간다. 이게 중요하다.
        //    원본은 JPA 라 INSERT 가 커밋 시점까지 지연돼 제약 위반도 커밋에서 터지고 롤백됐다.
        //    우리는 `insert()` 로 즉시 실행하므로, 여기서 잡고 early-return 해 버리면
        //    **차감된 재고만 커밋되고 쿠폰은 없는** 재고 누수가 생긴다. 그래서 예외를 트랜잭션
        //    밖까지 올려 롤백시킨 뒤 이 자리에서 멱등 종료한다 (최종 상태는 원본과 동일).
        this.logger.log(
          `unique violation on user_coupon insert (idempotent): userId=${request.userId}, couponTypeId=${request.couponTypeId}`,
        );
        return;
      }
      throw e;
    }

    if (checkAvailability) {
      await this.markSoldOutIfDepleted(request.eventId, request.couponTypeId);
    }
  }

  private async runIssueTransaction(
    request: CouponIssueRequestPayload,
    markAvailabilityCheck: () => void,
  ): Promise<void> {
    await this.dataSource.transaction(async (tx) => {
      if (
        await this.userCouponRepository.existsByUserIdAndCouponTypeId(
          tx,
          request.userId,
          request.couponTypeId,
        )
      ) {
        this.logger.log(
          `duplicate request — already issued: userId=${request.userId}, couponTypeId=${request.couponTypeId}`,
        );
        return;
      }

      const event = await this.eventRepository.findById(tx, request.eventId);
      if (event === null) {
        // 원본은 IllegalStateException 을 던져 consumer 가 실패한다. 동작을 그대로 둔다.
        throw new Error(`event not found: ${request.eventId}`);
      }

      const now = new Date();
      if (!event.isActive(now)) {
        await this.saveResult(tx, request, 'FAILED', null, now);
        await this.saveOutbox(
          tx,
          this.toResultPayload(request, 'FAILED', null, now),
        );
        this.logger.log(
          `event not active: eventId=${request.eventId}, userId=${request.userId}`,
        );
        return;
      }

      const inventory = await this.inventoryRepository.findForUpdate(
        tx,
        request.eventId,
        request.couponTypeId,
      );
      if (inventory === null) {
        throw new Error(
          `inventory not found: eventId=${request.eventId}, couponTypeId=${request.couponTypeId}`,
        );
      }

      if (!inventory.decrement()) {
        await this.saveResult(tx, request, 'SOLD_OUT', null, now);
        await this.saveOutbox(
          tx,
          this.toResultPayload(request, 'SOLD_OUT', null, now),
        );
        markAvailabilityCheck();
        this.logger.log(
          `sold out: eventId=${request.eventId}, couponTypeId=${request.couponTypeId}`,
        );
        return;
      }
      await this.inventoryRepository.updateAvailableCount(tx, inventory);

      const code = CouponCode.generate().value;
      // DuplicateUserCouponError 는 여기서 잡지 않는다 — 롤백되어야 한다 (process() 주석 참고).
      await this.saveResult(tx, request, 'SUCCESS', code, now);
      await this.saveOutbox(
        tx,
        this.toResultPayload(request, 'SUCCESS', code, now),
      );
      markAvailabilityCheck();
      this.logger.log(
        `issued: code=${code}, userId=${request.userId}, couponTypeId=${request.couponTypeId}`,
      );
    });
  }

  /**
   * ADR-011 — 커밋 **직후** 재고를 fresh read 해서 0 이면 negative cache 적재.
   *
   * 트랜잭션 안에서 결정하지 않는 이유: 롤백 시 ghost cache write 가 생기고,
   * 동시에 진행된 다른 트랜잭션의 최종 상태를 반영하지 못한다.
   * cache write 자체는 best-effort — 캐시는 권위가 아니다.
   */
  private async markSoldOutIfDepleted(
    eventId: number,
    couponTypeId: number,
  ): Promise<void> {
    try {
      const fresh = await this.inventoryRepository.findByEventIdAndCouponTypeId(
        this.dataSource.manager,
        eventId,
        couponTypeId,
      );
      if (fresh?.isDepleted()) {
        await this.availabilityCache.markSoldOut(eventId, couponTypeId);
      }
    } catch (e) {
      // MySQL hiccup / 커넥션 풀 고갈 등 — silent fail 방지. 캐시 누락은 다음 SOLD_OUT 이 회복.
      this.logger.warn(
        `availability post-check failed (cache write skipped): eventId=${eventId}, couponTypeId=${couponTypeId} reason=${String(e)}`,
      );
    }
  }

  private async saveResult(
    tx: TxContext,
    request: CouponIssueRequestPayload,
    status: UserCouponStatus,
    code: string | null,
    issuedAt: Date,
  ): Promise<void> {
    await this.userCouponRepository.insert(
      tx,
      UserCoupon.issue({
        code: code ?? placeholderCode(request.requestId),
        userId: request.userId,
        eventId: request.eventId,
        couponTypeId: request.couponTypeId,
        status,
        issuedAt,
      }),
    );
  }

  private async saveOutbox(
    tx: TxContext,
    payload: CouponIssueResultPayload,
  ): Promise<void> {
    await this.outboxRepository.append(tx, {
      // ⚠️ aggregate_id 에 requestId 가 들어가고, 이 값이 그대로 Kafka 메시지 key 가 된다
      //    (spec-parity §9). erd.md 의 "user_coupon_id 등" 설명과 다르다 — 코드가 권위.
      aggregateId: payload.requestId,
      eventType: EVENT_TYPE_ISSUE_RESULT,
      payload: JSON.stringify(payload),
    });
  }

  private toResultPayload(
    request: CouponIssueRequestPayload,
    status: CouponIssueResultStatus,
    couponCode: string | null,
    processedAt: Date,
  ): CouponIssueResultPayload {
    return {
      requestId: request.requestId,
      userId: request.userId,
      eventId: request.eventId,
      couponTypeId: request.couponTypeId,
      status,
      couponCode,
      processedAt: toInstantString(processedAt),
    };
  }
}

/**
 * SOLD_OUT / FAILED 일 때도 `user_coupon` row 를 남겨 사용자 폴링 응답이 가능하게 한다.
 *
 * ⚠️ `CouponCode` VO 를 거치지 않는다 — requestId(UUID) 조각이라 VO 의 알파벳 규칙을 만족하지 않는다.
 *    원본 `generatePlaceholderCode` 와 동일한 **의도된 우회**다 (spec-parity §9).
 */
function placeholderCode(requestId: string): string {
  return `X${requestId.substring(0, Math.min(11, requestId.length))}`;
}
