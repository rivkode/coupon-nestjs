import { ApiResponses, UserId, type ApiResponse } from '@app/common';
import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { RedeemCommand } from '../application/redeem.command';
import { RedeemCouponService } from '../application/redeem-coupon.service';
import { toRedeemView, type RedeemCouponView } from './redeem-coupon.view';

/**
 * 쿠폰 사용 (ADR-007). 원본 `RedeemCouponController`. Idempotency-Key 헤더는 쓰지 않는다 (ADR-004).
 *
 * 매핑:
 *  - 200 — 정상 redeem 또는 같은 user 의 멱등 재호출
 *  - 404 `NOT_FOUND` — 코드 없음 / 다른 user (마스킹)
 *  - 409 `RACE_RETRY` — 낙관락 충돌 / `INVALID_STATE` — 사용 불가 상태
 *  - 400 `MISSING_HEADER` — X-User-Id 누락
 */
@Controller('api/v1/coupons')
export class RedeemCouponController {
  constructor(private readonly redeemCouponService: RedeemCouponService) {}

  // ⚠️ Nest 의 `@Post()` 기본 응답은 **201** 이다. 원본은 `ResponseEntity.status(HttpStatus.OK)` 로
  //    200 을 내므로 명시적으로 고정한다. 빠뜨리면 계약이 조용히 틀어진다 (api-contract §1).
  @Post(':code/redeem')
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Param('code') code: string,
    @UserId() userId: number,
  ): Promise<ApiResponse<RedeemCouponView>> {
    const result = await this.redeemCouponService.redeem(
      new RedeemCommand(code, userId),
    );
    return ApiResponses.success(toRedeemView(result));
  }
}
