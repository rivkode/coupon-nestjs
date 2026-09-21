import { ApiResponses, ParseLongPipe, type ApiResponse } from '@app/common';
import { Controller, Get, Param } from '@nestjs/common';
import { UserCouponQueryService } from '../application/user-coupon-query.service';
import type { UserCouponInternalView } from '../application/views';
import { CouponNotFoundError } from '../domain/exception/coupon-not-found.error';

/**
 * server-b 의 스케줄러가 호출하는 internal API (ADR-008). 원본 `UserCouponInternalController`.
 *
 * 10 초 이상 pending 인 신청에 대해 b 가 이 endpoint 로 직접 조회 → 결과를 Redis 에 반영한다.
 *
 * ⚠️ **봉투를 사용한다** (`success`/`data`). 봉투 없이 raw 로 나가는 것은 server-b 의
 *    `POST /internal/v1/coupons/issue` 쪽이다 (api-contract §2/§3).
 *
 * 매핑:
 *  - 200 — user_coupon 존재
 *  - 404 `NOT_FOUND` — 아직 처리 전 (Kafka 컨슘 대기). 스케줄러는 다음 cycle 에 재시도한다.
 */
@Controller('internal/v1/users')
export class UserCouponInternalController {
  constructor(private readonly queryService: UserCouponQueryService) {}

  @Get(':userId/coupons/:couponTypeId')
  async findOne(
    @Param('userId', ParseLongPipe) userId: number,
    @Param('couponTypeId', ParseLongPipe) couponTypeId: number,
  ): Promise<ApiResponse<UserCouponInternalView>> {
    const view = await this.queryService.findByUserIdAndCouponTypeId(
      userId,
      couponTypeId,
    );
    if (view === null) {
      throw new CouponNotFoundError(
        `user_coupon not found: userId=${userId}, couponTypeId=${couponTypeId}`,
      );
    }
    return ApiResponses.success(view);
  }
}
