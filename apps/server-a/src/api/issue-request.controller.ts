import { ApiResponses, UserId, type ApiResponse } from '@app/common';
import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IssueCommand } from '../application/issue.command';
import { IssueRequestService } from '../application/issue-request.service';
import { IssueCouponRequestDto } from './dto/issue-coupon-request.dto';
import { toIssueCouponView, type IssueCouponView } from './issue-coupon.view';

/** Circuit Breaker OPEN / B 장애 시 클라이언트에게 알려주는 재시도 간격 (초). */
const RETRY_AFTER_SECONDS = '5';

/**
 * 발급 요청 진입점 (원본 `IssueRequestController`). 즉시 "접수 완료" 를 응답한다.
 *
 * 매핑:
 *  - **200** — `ACCEPTED` / `DUPLICATE` / `SOLD_OUT` (사용자에겐 모두 200, 결과는 조회로)
 *  - **503 + `Retry-After: 5`** — Circuit Breaker OPEN 또는 B 일시 장애
 *  - 400 — 헤더 누락 / 본문 검증 실패
 *
 * ⚠️ 503 응답도 **봉투는 `success: true`** 다. 요청 자체는 정상 처리됐고
 *    downstream 이 일시적으로 불가하다는 뜻이라, `data.status` 가 `INTERNAL_ERROR` 를 담는다
 *    (api-contract §1). 이상해 보여도 그대로 둔다 — 호출자가 이 형태에 의존한다.
 */
@Controller('api/v1/coupons')
export class IssueRequestController {
  constructor(private readonly service: IssueRequestService) {}

  @Post('issue-request')
  async issue(
    @UserId() userId: number,
    @Body() request: IssueCouponRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<IssueCouponView>> {
    const outcome = await this.service.issue(
      new IssueCommand(userId, request.eventId, request.couponTypeId),
    );

    if (outcome.isDownstreamUnavailable()) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      res.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    } else {
      // Nest 의 @Post() 기본값은 201 이다. 명시하지 않으면 계약이 조용히 틀어진다.
      res.status(HttpStatus.OK);
    }

    return ApiResponses.success(toIssueCouponView(outcome));
  }
}
