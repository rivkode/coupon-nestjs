import { ApiResponses, ParseLongPipe, type ApiResponse } from '@app/common';
import { Controller, Get, Param } from '@nestjs/common';
import { EventQueryService } from '../application/event-query.service';
import type { EventView } from '../application/views';

/**
 * 이벤트 조회 API (원본 `EventQueryController`) — 평가항목 ③ Hot Spot / Cache stampede 검증 대상.
 *
 * ⚠️ **인증 헤더를 받지 않는다.** 원본 컨트롤러도 `@PathVariable` 만 받는다.
 *    api-spec.md 의 "인증 (선택)" 표기는 부정확하다 (spec-parity §1).
 *
 * 매핑:
 *  - 200 — 캐시 또는 DB
 *  - 400 `TYPE_MISMATCH` — eventId 가 숫자가 아님
 *  - 404 `EVENT_NOT_FOUND` — 미존재
 */
@Controller('api/v1/events')
export class EventQueryController {
  constructor(private readonly eventQueryService: EventQueryService) {}

  @Get(':eventId')
  async findOne(
    @Param('eventId', ParseLongPipe) eventId: number,
  ): Promise<ApiResponse<EventView>> {
    return ApiResponses.success(await this.eventQueryService.findById(eventId));
  }
}
