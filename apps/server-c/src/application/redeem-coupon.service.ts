import { InvalidStateError } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CouponNotFoundError } from '../domain/exception/coupon-not-found.error';
import { OptimisticLockFailureError } from '../domain/exception/optimistic-lock-failure.error';
import { UserCouponRepository } from '../domain/user-coupon.repository';
import type { RedeemCommand } from './redeem.command';
import { RedeemResult } from './redeem.result';

/**
 * Redeem 애플리케이션 서비스 (ADR-007 / ADR-N03). 원본 `RedeemCouponService` 와 **순서가 같다**:
 *
 *  1. code 로 user_coupon 조회 → 없으면 404
 *  2. 소유권 검증 (다른 user → **404 로 마스킹** — 존재 여부를 흘리지 않는다)
 *  3. 이미 USED → 같은 user 의 재호출은 멱등 200, `redeemedAt` 은 최초 사용 시각 그대로
 *  4. 조건부 UPDATE 로 USED 전이 → `affected === 0` 이면 낙관락 충돌 (409 RACE_RETRY)
 *
 * ⚠️ 원본은 `@Version` + `save()` 로 낙관락을 걸었지만 TypeORM 은 같은 방식이 **동작하지 않는다**.
 *    `WHERE version = ?` 가드를 직접 걸고 `affected` 로 판정한다 (ADR-N03).
 */
@Injectable()
export class RedeemCouponService {
  private readonly logger = new Logger(RedeemCouponService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly repository: UserCouponRepository,
  ) {}

  async redeem(command: RedeemCommand): Promise<RedeemResult> {
    return this.dataSource.transaction(async (tx) => {
      const coupon = await this.repository.findByCode(tx, command.code);
      if (coupon === null) {
        throw new CouponNotFoundError(`coupon not found: code=${command.code}`);
      }

      if (!coupon.isOwnedBy(command.userId)) {
        this.logger.warn(
          `redeem ownership mismatch: code=${command.code}, owner=${coupon.userId}, requester=${command.userId}`,
        );
        // 소유자가 아니면 "없음" 과 구분되지 않게 같은 404 를 낸다.
        throw new CouponNotFoundError(`coupon not found: code=${command.code}`);
      }

      if (coupon.isRedeemed()) {
        this.logger.log(
          `redeem idempotent replay: code=${command.code}, userId=${command.userId}`,
        );
        // usedAt 은 isRedeemed() 가 true 인 이상 non-null 이다.
        return RedeemResult.alreadyRedeemed(
          coupon.code,
          coupon.userId,
          coupon.usedAt as Date,
        );
      }

      if (!coupon.isRedeemable()) {
        // 발급 자체가 SOLD_OUT / FAILED 였던 쿠폰 → 409 INVALID_STATE
        throw new InvalidStateError(
          `coupon is not redeemable: status=${coupon.status}`,
        );
      }

      const now = new Date();
      const affected = await this.repository.markUsed(
        tx,
        coupon.id as number,
        coupon.version,
        now,
      );
      if (affected === 0) {
        // 조회와 UPDATE 사이에 다른 요청이 선점했다 → 즉시 재시도 가능 (409 RACE_RETRY)
        throw new OptimisticLockFailureError(
          `concurrent redeem detected: code=${command.code}, version=${coupon.version}`,
        );
      }

      this.logger.log(
        `redeem succeeded: code=${command.code}, userId=${command.userId}`,
      );
      return RedeemResult.succeeded(coupon.code, coupon.userId, now);
    });
  }
}
