import { UserId } from '@app/common';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CouponIssueAcceptService } from '../application/coupon-issue-accept.service';
import { IssueRequestDto } from './dto/issue-request.dto';
import { toIssueResponse, type IssueResponseView } from './issue-response.view';

/**
 * server-a 가 호출하는 internal 발급 endpoint (원본 `CouponIssueController`).
 * ADR-001 — 즉시 "접수 완료" 응답.
 *
 * ⚠️ **응답 봉투를 쓰지 않는다.** 이 endpoint 만 raw payload 로 나간다 (spec-parity §2/§3).
 *    server-a 가 받아서 자기 봉투로 다시 감싸 사용자에게 전달한다.
 *
 * ⚠️ `@Post()` 기본값은 201 이라 200 으로 고정한다 (원본은 `ResponseEntity` 기본 200).
 *
 * ⚠️ `X-User-Id` 가 필수인데 **server-b 에는 MISSING_HEADER 핸들러가 없다** —
 *    헤더가 없으면 400 이 아니라 500 `INTERNAL_ERROR` 가 나간다 (spec-parity §4, 원본 동작).
 */
@Controller('internal/v1/coupons')
export class CouponIssueController {
  constructor(private readonly service: CouponIssueAcceptService) {}

  @Post('issue')
  @HttpCode(HttpStatus.OK)
  async issue(
    @UserId() userId: number,
    @Body() request: IssueRequestDto,
  ): Promise<IssueResponseView> {
    const result = await this.service.accept(
      userId,
      request.eventId,
      request.couponTypeId,
    );
    // null 필드를 떨어뜨려 원본의 @JsonInclude(NON_NULL) 결과와 같게 만든다.
    return toIssueResponse(result);
  }
}
