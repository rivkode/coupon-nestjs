import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { MissingHeaderError, TypeMismatchError } from './errors';

/** 헤더 이름 — 계약 (api-spec §0.1). express 가 소문자로 정규화한다. */
export const USER_ID_HEADER = 'X-User-Id';

/** 원본 컨트롤러의 파라미터 이름. `TYPE_MISMATCH` 메시지에 그대로 들어가므로 계약이다. */
const USER_ID_PARAM_NAME = 'userId';

/** Java `Long.parseLong` 이 받아들이는 형태. `"1.5"`, `"1e3"`, `" 1"` 은 전부 거부된다. */
const LONG_PATTERN = /^[+-]?\d+$/;

/**
 * 원본 `@RequestHeader("X-User-Id") Long userId` 에 대응한다
 * (`IssueRequestController`, `RedeemCouponController`, `UserCouponController`).
 *
 * 매핑 (api-contract §4):
 *  - 헤더 없음 → `MissingHeaderError` → a/c 400 `MISSING_HEADER`, **b 는 핸들러가 없어 500 `INTERNAL_ERROR`**
 *  - Long 변환 실패 → Spring 의 `MethodArgumentTypeMismatchException` 에 대응하는
 *    `TypeMismatchError` → 400 `TYPE_MISMATCH`, message `"argument type mismatch: userId"`
 *
 * ⚠️ **범위 검증을 추가하지 않는다.** 원본은 `X-User-Id: 0` / `-5` 를 그대로 통과시켜
 *    200 응답 + `issue_request` 적재까지 진행한다. "더 나은 검증" 을 넣으면 계약이 달라진다.
 *
 * 반환 타입은 **number** — wire·도메인 모두 number 로 통일 (typeorm-patterns §6.1).
 * Java `long` 은 2^63 까지지만 JS number 는 2^53 까지다. 이 시스템의 user_id 범위에서는
 * 문제가 없고, 원본도 JSON 으로 내보낼 때 같은 제약을 받는다.
 */
export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const raw = req.headers[USER_ID_HEADER.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (value == null || value === '') {
      throw new MissingHeaderError(USER_ID_HEADER);
    }

    if (!LONG_PATTERN.test(value)) {
      throw new TypeMismatchError(USER_ID_PARAM_NAME);
    }
    return Number(value);
  },
);
