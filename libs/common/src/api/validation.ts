import { ValidationPipe, type ValidationPipeOptions } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { ValidationFailedError } from './errors';

/**
 * Spring 의 `@Valid` + `MethodArgumentNotValidException` 에 대응하는 전역 파이프.
 *
 * 기본 ValidationPipe 는 `BadRequestException` 을 던지고 Nest 기본 포맷으로 응답해 버린다.
 * 원본은 필드별 에러를 `fieldErrors` 배열로 내려주므로, exceptionFactory 에서
 * `ValidationFailedError` 로 바꿔 던지고 ExceptionFilter 가 봉투를 씌운다 (api-contract §3/§4).
 */
export function createValidationPipe(
  options: ValidationPipeOptions = {},
): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    ...options,
    exceptionFactory: (errors: ValidationError[]) =>
      new ValidationFailedError(flattenValidationErrors(errors)),
  });
}

/** 중첩 객체까지 펼쳐 `field` 를 점 표기로 만든다 (Spring 의 FieldError#getField 와 같은 형태). */
function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = [];
  for (const err of errors) {
    const path = parentPath ? `${parentPath}.${err.property}` : err.property;
    if (err.constraints) {
      for (const message of Object.values(err.constraints)) {
        out.push({ field: path, message });
      }
    }
    if (err.children?.length) {
      out.push(...flattenValidationErrors(err.children, path));
    }
  }
  return out;
}
