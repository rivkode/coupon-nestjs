import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ERROR_CODE,
  ERROR_MESSAGE,
  ErrorResponses,
  type ErrorResponse,
} from './api-response';
import {
  InvalidArgumentError,
  MalformedBodyError,
  MissingHeaderError,
  TypeMismatchError,
  ValidationFailedError,
} from './errors';

export interface MappedError {
  status: number;
  error: ErrorResponse;
}

/**
 * server-a / b / c 의 `GlobalExceptionHandler` 가 **공통으로** 갖는 매핑만 담는다.
 *
 * 서버마다 다른 매핑은 각 앱의 필터가 담당한다 (api-contract §4):
 *  - `InvalidStateError` → a/c: 409 INVALID_STATE, b: 500 INTERNAL_STATE
 *  - `MissingHeaderError` → a/c: 400 MISSING_HEADER, b: **핸들러 없음** → 500 INTERNAL_ERROR
 *  - 도메인 NotFound / 낙관락 → c 전용
 *
 * 매칭되지 않으면 null 을 돌려주고, 호출한 필터가 자기 매핑 → 최종 fallback 순으로 처리한다.
 *
 * ⚠️ 깨진 JSON 은 여기서 처리하지 않는다 — Nest 라우터 앞단의 body parser 가 잡아
 *    직접 봉투를 쓴다 (`useEnvelopeAwareBodyParser`). Nest 가 원인 정보를 지워버리기 때문이다.
 */
export function mapCommonError(exception: unknown): MappedError | null {
  if (exception instanceof ValidationFailedError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: ErrorResponses.withFields(
        ERROR_CODE.VALIDATION_FAILED,
        ERROR_MESSAGE.VALIDATION_FAILED,
        [...exception.fieldErrors],
      ),
    };
  }

  if (exception instanceof MalformedBodyError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: ErrorResponses.of(
        ERROR_CODE.MALFORMED_BODY,
        ERROR_MESSAGE.MALFORMED_BODY,
      ),
    };
  }

  if (exception instanceof TypeMismatchError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: ErrorResponses.of(
        ERROR_CODE.TYPE_MISMATCH,
        ERROR_MESSAGE.typeMismatch(exception.argumentName),
      ),
    };
  }

  if (exception instanceof InvalidArgumentError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: ErrorResponses.of(ERROR_CODE.INVALID_ARGUMENT, exception.message),
    };
  }

  return null;
}

/** a/c 전용 — b 에는 이 핸들러가 없다 (원본 GlobalExceptionHandler 에 MissingRequestHeader 핸들러 부재). */
export function mapMissingHeader(exception: unknown): MappedError | null {
  if (exception instanceof MissingHeaderError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: ErrorResponses.of(
        ERROR_CODE.MISSING_HEADER,
        ERROR_MESSAGE.missingHeader(exception.headerName),
      ),
    };
  }
  return null;
}

/**
 * Nest/express 가 던지는 `HttpException` (404 없는 경로, 405, 415, 413 …) 을 봉투에 담는다.
 *
 * 원본은 `@ExceptionHandler(Exception.class)` 가 이들을 전부 잡아 500 봉투를 냈지만,
 * 상태코드를 500 으로 뭉개면 운영 중 오진단을 부른다. **상태코드는 살리고 본문만 봉투로** 맞춘다
 * (사용자 결정, ADR-N06). 스펙에 없는 경로라 계약 API 에는 영향이 없다.
 *
 * ⚠️ 여기서 나오는 `code` 는 **원본에 없는 값**이다 (404 의 `NOT_FOUND` 는 server-c 계약 코드와
 *    문자열이 겹치지만, a/b 에서는 원본에 없던 코드다). §4 표의 11종과 혼동하지 말 것.
 *
 * ⚠️ `/actuator/health` 의 503 은 여기로 오지 않는다 — health 컨트롤러가 직접 처리해
 *    원본 Actuator 본문(`{"status":"DOWN"}`)을 유지한다.
 */
export function mapHttpException(exception: HttpException): MappedError {
  const status = exception.getStatus();
  const res = exception.getResponse();
  const message =
    typeof res === 'string'
      ? res
      : (() => {
          const m = (res as { message?: string | string[] }).message;
          if (Array.isArray(m)) return m.join(', ');
          return m ?? exception.message;
        })();

  return {
    status,
    error: ErrorResponses.of(httpStatusCode(status), message),
  };
}

/** HTTP 상태 → SCREAMING_SNAKE 코드. `404 → NOT_FOUND`, `405 → METHOD_NOT_ALLOWED`. */
function httpStatusCode(status: number): string {
  const name = HttpStatus[status] as string | undefined;
  return name ?? ERROR_CODE.INTERNAL_ERROR;
}

export function internalError(): MappedError {
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: ErrorResponses.of(
      ERROR_CODE.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL_ERROR,
    ),
  };
}
