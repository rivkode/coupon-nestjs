import {
  BaseExceptionFilter,
  ERROR_CODE,
  ErrorResponses,
  InvalidStateError,
  mapCommonError,
  type MappedError,
} from '@app/common';
import { Catch, HttpStatus, Logger } from '@nestjs/common';

/**
 * server-b 전역 예외 핸들러 — 원본 `serverb/api/exception/GlobalExceptionHandler.java`.
 *
 * ⚠️ a/c 와 **의도적으로 다른 두 지점** (spec-parity §4). 통일하지 말 것:
 *  1. `InvalidStateError` → **500 INTERNAL_STATE** (+ ERROR 로그). a/c 의 409 INVALID_STATE 가 아니다.
 *     내부 API 라 도메인 상태 충돌이 있을 수 없고, 있으면 그건 버그라는 판단.
 *  2. **MISSING_HEADER 매핑이 없다.** 원본 b 에는 MissingRequestHeaderException 핸들러가 없어
 *     헤더 누락이 generic handler 로 떨어져 500 INTERNAL_ERROR 가 된다 —
 *     여기서도 `mapMissingHeader` 를 부르지 않아 같은 결과가 된다.
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  protected readonly logger = new Logger(GlobalExceptionFilter.name);

  protected mapDomain(exception: unknown): MappedError | null {
    const common = mapCommonError(exception);
    if (common) return common;

    if (exception instanceof InvalidStateError) {
      this.logger.error('illegal state', exception.stack);
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: ErrorResponses.of(ERROR_CODE.INTERNAL_STATE, exception.message),
      };
    }

    return null;
  }
}
