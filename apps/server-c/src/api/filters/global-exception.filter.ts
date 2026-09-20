import {
  BaseExceptionFilter,
  ERROR_CODE,
  ERROR_MESSAGE,
  ErrorResponses,
  InvalidStateError,
  mapCommonError,
  mapMissingHeader,
  type MappedError,
} from '@app/common';
import { Catch, HttpStatus, Logger } from '@nestjs/common';
import { CouponNotFoundError } from '../../domain/exception/coupon-not-found.error';
import { EventNotFoundError } from '../../domain/exception/event-not-found.error';
import { OptimisticLockFailureError } from '../../domain/exception/optimistic-lock-failure.error';

/**
 * server-c 전역 예외 핸들러 — 원본 `serverc/api/exception/GlobalExceptionHandler.java`.
 * a 의 핸들러와 동일 형식 + redeem 영역의 예외 (낙관락, 도메인 NotFound) 매핑 추가.
 *
 * 매핑 (spec-parity §4):
 *  - CouponNotFoundError        → 404 NOT_FOUND       ("coupon not found" — 소유권 마스킹 포함)
 *  - EventNotFoundError         → 404 EVENT_NOT_FOUND ("event not found")
 *  - OptimisticLockFailureError → 409 RACE_RETRY      (+ INFO 로그)
 *  - InvalidStateError          → 409 INVALID_STATE
 *  - 공통 400 계열 + MISSING_HEADER
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  protected readonly logger = new Logger(GlobalExceptionFilter.name);

  protected mapDomain(exception: unknown): MappedError | null {
    if (exception instanceof CouponNotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        error: ErrorResponses.of(ERROR_CODE.NOT_FOUND, ERROR_MESSAGE.NOT_FOUND),
      };
    }

    if (exception instanceof EventNotFoundError) {
      return {
        status: HttpStatus.NOT_FOUND,
        error: ErrorResponses.of(
          ERROR_CODE.EVENT_NOT_FOUND,
          ERROR_MESSAGE.EVENT_NOT_FOUND,
        ),
      };
    }

    if (exception instanceof OptimisticLockFailureError) {
      this.logger.log(`optimistic lock retry: ${exception.message}`);
      return {
        status: HttpStatus.CONFLICT,
        error: ErrorResponses.of(
          ERROR_CODE.RACE_RETRY,
          ERROR_MESSAGE.RACE_RETRY,
        ),
      };
    }

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
