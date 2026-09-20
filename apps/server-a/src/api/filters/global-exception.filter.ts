import {
  BaseExceptionFilter,
  ERROR_CODE,
  ErrorResponses,
  InvalidStateError,
  mapCommonError,
  mapMissingHeader,
  type MappedError,
} from '@app/common';
import { Catch, HttpStatus, Logger } from '@nestjs/common';

/**
 * server-a 전역 예외 핸들러 — 원본 `servera/api/exception/GlobalExceptionHandler.java`.
 *
 * 매핑 (spec-parity §4):
 *  - VALIDATION_FAILED / MALFORMED_BODY / TYPE_MISMATCH / INVALID_ARGUMENT → 400
 *  - MISSING_HEADER → 400
 *  - InvalidStateError → 409 INVALID_STATE
 *  - 그 외 → BaseExceptionFilter (HttpException 통과 / 500 INTERNAL_ERROR)
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  protected readonly logger = new Logger(GlobalExceptionFilter.name);

  protected mapDomain(exception: unknown): MappedError | null {
    const common = mapCommonError(exception) ?? mapMissingHeader(exception);
    if (common) return common;

    if (exception instanceof InvalidStateError) {
      return {
        status: HttpStatus.CONFLICT,
        error: ErrorResponses.of(ERROR_CODE.INVALID_STATE, exception.message),
      };
    }

    return null;
  }
}
