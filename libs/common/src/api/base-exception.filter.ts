import {
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiResponses } from './api-response';
import {
  internalError,
  mapHttpException,
  type MappedError,
} from './common-error-mapping';

/**
 * 세 앱의 전역 예외 필터가 공유하는 뼈대 — Spring 의 `@RestControllerAdvice` 자리.
 *
 * 처리 순서 (ADR-N06):
 *  1. `mapDomain()` — 각 앱이 정의한 계약 예외 → 봉투 + 에러코드 (spec-parity §4)
 *  2. `HttpException` — Nest/express 가 던진 것(404/405/415/413 …).
 *     **상태코드는 살리고 본문만 봉투로** 감싼다.
 *  3. 그 외 — 500 INTERNAL_ERROR (메시지 마스킹 + ERROR 로그)
 *
 * 2번이 필요한 이유: `@Catch()` 는 인자가 없으면 Nest 내부 예외까지 전부 잡는다.
 * 전부 500 으로 뭉개면 원본과는 같아지지만 운영 중 오진단을 부르고,
 * 그대로 통과시키면 이 경로만 봉투가 아니게 된다. 사용자 결정으로 절충안을 택했다.
 *
 * ⚠️ Java 와의 차이: 원본은 `@ExceptionHandler(Exception.class)` 가 매핑 안 된 예외를 전부 잡아
 *    없는 경로/405/415 에서도 500 `INTERNAL_ERROR` 봉투를 낸다. 우리는 404/405/415 를 유지한다.
 *    이때 쓰는 `code` 는 원본에 없는 값이다 (§4 의 계약 11종과 별개).
 *
 * ⚠️ `/actuator/health` 의 503 은 여기로 오지 않는다 — health 컨트롤러가 직접 응답해
 *    원본 Actuator 본문(`{"status":"DOWN"}`)을 유지한다.
 */
export abstract class BaseExceptionFilter implements ExceptionFilter {
  protected abstract readonly logger: Logger;

  /** 앱별 계약 예외 매핑. 해당 없으면 null. */
  protected abstract mapDomain(exception: unknown): MappedError | null;

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const mapped = this.mapDomain(exception);
    if (mapped) {
      res.status(mapped.status).json(ApiResponses.failure(mapped.error));
      return;
    }

    if (exception instanceof HttpException) {
      const wrapped = mapHttpException(exception);
      res.status(wrapped.status).json(ApiResponses.failure(wrapped.error));
      return;
    }

    this.logger.error(
      'unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    const fallback = internalError();
    res.status(fallback.status).json(ApiResponses.failure(fallback.error));
  }
}
