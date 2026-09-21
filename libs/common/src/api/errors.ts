/**
 * 프레임워크 비의존 예외 — `domain/` 에서도 던질 수 있다 (nest-ddd-layering §1).
 *
 * Java 는 `IllegalArgumentException` / `IllegalStateException` 같은 JDK 예외를 그대로 쓰고
 * `GlobalExceptionHandler` 가 HTTP 로 매핑했다. TS 에는 대응하는 표준 예외가 없어
 * 같은 의미의 클래스를 여기서 정의하고, 각 앱의 ExceptionFilter 가 매핑한다.
 */

/** Java `IllegalArgumentException` — 도메인 인자 검증 실패 → 400 INVALID_ARGUMENT */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * Java `IllegalStateException` — 도메인 상태 전이 실패.
 * ⚠️ 매핑이 서버마다 다르다: a/c → 409 INVALID_STATE, **b → 500 INTERNAL_STATE** (api-contract §4).
 */
export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

/** Java `MissingRequestHeaderException` — 필수 헤더 누락 → 400 MISSING_HEADER (a/c) */
export class MissingHeaderError extends Error {
  constructor(readonly headerName: string) {
    super(`required header missing: ${headerName}`);
    this.name = 'MissingHeaderError';
  }
}

/** Java `MethodArgumentTypeMismatchException` — path/query 타입 불일치 → 400 TYPE_MISMATCH */
export class TypeMismatchError extends Error {
  constructor(readonly argumentName: string) {
    super(`argument type mismatch: ${argumentName}`);
    this.name = 'TypeMismatchError';
  }
}

/**
 * Java `MethodArgumentNotValidException` — bean validation 실패 → 400 VALIDATION_FAILED.
 * ValidationPipe 의 exceptionFactory 가 class-validator 결과를 이 형태로 바꿔 던진다.
 */
export class ValidationFailedError extends Error {
  constructor(
    readonly fieldErrors: ReadonlyArray<{ field: string; message: string }>,
  ) {
    super('request body validation failed');
    this.name = 'ValidationFailedError';
  }
}

/** Java `HttpMessageNotReadableException` — JSON 파싱 실패 → 400 MALFORMED_BODY */
export class MalformedBodyError extends Error {
  constructor() {
    super('request body is malformed');
    this.name = 'MalformedBodyError';
  }
}
