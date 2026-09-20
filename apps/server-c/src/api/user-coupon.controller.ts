import { ApiResponses, UserId, type ApiResponse } from '@app/common';
import { Controller, Get } from '@nestjs/common';
import { UserCouponQueryService } from '../application/user-coupon-query.service';
import type { UserCouponView } from '../application/views';

/**
 * 사용자 본인의 쿠폰 목록 조회 (원본 `UserCouponController`).
 *
 * "내 자원" endpoint 라 path 에 userId 를 두지 않고 `X-User-Id` 헤더가 사용자를 결정한다
 * (`/me` 패턴 — GitHub `/users/me/...`, Microsoft Graph `/me/...` 관행).
 *
 * 페이지네이션은 사용자당 이벤트 상한이 100 이라 적용하지 않는다 (scope-discipline).
 */
@Controller('api/v1/users/me')
export class UserCouponController {
  constructor(private readonly queryService: UserCouponQueryService) {}

  @Get('coupons')
  async findMine(
    @UserId() userId: number,
  ): Promise<ApiResponse<UserCouponView[]>> {
    return ApiResponses.success(
      await this.queryService.findAllByUserId(userId),
    );
  }
}
