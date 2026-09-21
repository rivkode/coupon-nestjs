/**
 * 공통 응답 봉투 (api-contract §3).
 *
 * Java 원본은 server-a/b/c 각각의 `api/dto/ApiResponse.java` 에 **동일한 내용으로 중복** 정의되어 있다.
 * 모노레포에서는 값 타입이 완전히 같으므로 libs/common 으로 합쳤다 — 의도된 구조 차이이며
 * 직렬화 결과는 동일하다. 반면 **ExceptionFilter 는 서버마다 매핑이 달라 합치지 않는다** (§4 표 참조).
 *
 * 직렬화 시 null 필드는 생략 (Java `@JsonInclude(NON_NULL)`).
 * TS 에서는 `undefined` 를 쓰면 `JSON.stringify` 가 키를 떨어뜨리므로 null 대신 undefined 를 쓴다.
 * ⚠️ 단, `data` 안쪽 DTO 의 null 생략 여부는 DTO 가 정한다 —
 *    내 쿠폰 목록의 `usedAt` 은 null 이어도 **생략하지 않는다** (§3).
 */
export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorResponse {
  code: string;
  message: string;
  fieldErrors?: FieldError[];
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ErrorResponse;
}

export const ApiResponses = {
  success<T>(data: T): ApiResponse<T> {
    return { success: true, data };
  },
  failure(error: ErrorResponse): ApiResponse<never> {
    return { success: false, error };
  },
} as const;

export const ErrorResponses = {
  of(code: string, message: string): ErrorResponse {
    return { code, message };
  },
  withFields(
    code: string,
    message: string,
    fieldErrors: FieldError[],
  ): ErrorResponse {
    return { code, message, fieldErrors };
  },
} as const;

/**
 * 표준 에러 코드 (api-contract §4). 11종 — `api-spec.md` 는 10종만 적고 있으나
 * server-b 가 `INTERNAL_STATE` 를 추가로 쓴다.
 */
export const ERROR_CODE = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MISSING_HEADER: 'MISSING_HEADER',
  MALFORMED_BODY: 'MALFORMED_BODY',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  /** server-b 전용 — b 는 IllegalStateException 상당을 500 으로 올린다 */
  INTERNAL_STATE: 'INTERNAL_STATE',
  RACE_RETRY: 'RACE_RETRY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** 에러 메시지 상수 — 메시지 문자열도 계약이다 (api-contract §4). */
export const ERROR_MESSAGE = {
  VALIDATION_FAILED: 'request body validation failed',
  MALFORMED_BODY: 'request body is malformed',
  NOT_FOUND: 'coupon not found',
  EVENT_NOT_FOUND: 'event not found',
  RACE_RETRY: 'concurrent modification — retry the request',
  INTERNAL_ERROR: 'internal server error',
  missingHeader: (name: string) => `required header missing: ${name}`,
  typeMismatch: (name: string) => `argument type mismatch: ${name}`,
} as const;
