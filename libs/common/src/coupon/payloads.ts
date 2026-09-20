import { InvalidArgumentError } from '../api/errors';
import type {
  CouponIssueResultStatus,
  IssueAcceptanceStatus,
} from './statuses';

/**
 * Kafka 메시지 payload — 필드명·순서가 곧 wire 계약이다 (spec-parity §9).
 *
 * ID 타입 주의: DB 는 BIGINT 지만 **wire 는 JSON number** 다 (Java `long` 직렬화 결과).
 * TypeORM 이 돌려주는 string 을 그대로 실으면 계약이 깨지므로,
 * 영속 경계에서 number 로 정규화한 뒤 payload 를 만든다.
 *
 * 시각 필드는 Java `Instant` → ISO-8601 문자열.
 */

/**
 * server-b → server-c (`coupon-issue-request` 토픽). 발급 신청 이벤트.
 * 메시지 key = userId (같은 user 의 이벤트는 partition 순서 보장).
 */
export interface CouponIssueRequestPayload {
  requestId: string;
  userId: number;
  eventId: number;
  couponTypeId: number;
  /** ISO-8601 */
  requestedAt: string;
}

/**
 * 원본 record 의 compact constructor 검증을 그대로 옮긴 것.
 *
 * ⚠️ 예외 종류가 곧 HTTP 상태코드다 (spec-parity §4). 원본과 1:1로 맞춘다:
 *  - `IllegalArgumentException` (isBlank / must be positive) → `InvalidArgumentError` → **400 INVALID_ARGUMENT**
 *  - `Objects.requireNonNull` (= `NullPointerException`) → 매핑 없음 → **500 INTERNAL_ERROR**
 * 후자를 `InvalidArgumentError` 로 올리면 원본이 500 을 내는 자리에서 400 이 나간다.
 */
export function assertIssueRequestPayload(p: CouponIssueRequestPayload): void {
  // Objects.requireNonNull(requestId) → NPE → 500
  if (p.requestId == null) throw new Error('requestId');
  // requestId.isBlank() → IllegalArgumentException → 400
  if (p.requestId.trim() === '') {
    throw new InvalidArgumentError('requestId must not be blank');
  }
  if (!(p.userId > 0)) {
    throw new InvalidArgumentError(`userId must be positive: ${p.userId}`);
  }
  if (!(p.eventId > 0)) {
    throw new InvalidArgumentError(`eventId must be positive: ${p.eventId}`);
  }
  if (!(p.couponTypeId > 0)) {
    throw new InvalidArgumentError(
      `couponTypeId must be positive: ${p.couponTypeId}`,
    );
  }
  // Objects.requireNonNull(requestedAt) → NPE → 500
  if (p.requestedAt == null) throw new Error('requestedAt');
}

/**
 * server-c → server-b (`coupon-issue-result` 토픽). 발급 처리 결과 이벤트.
 * 메시지 key = userId. `couponCode` 는 status === 'SUCCESS' 일 때만 non-null.
 *
 * ⚠️ 필드명은 `couponCode` 다 — Redis hash 필드명(`code`)과 혼동하지 말 것.
 */
export interface CouponIssueResultPayload {
  requestId: string;
  userId: number;
  eventId: number;
  couponTypeId: number;
  status: CouponIssueResultStatus;
  couponCode: string | null;
  /** ISO-8601 */
  processedAt: string;
}

export function assertIssueResultPayload(p: CouponIssueResultPayload): void {
  if (p.requestId == null) throw new Error('requestId');
  if (p.status == null) throw new Error('status');
  if (p.status === 'SUCCESS' && p.couponCode == null) {
    throw new Error('couponCode (status=SUCCESS)');
  }
  if (p.processedAt == null) throw new Error('processedAt');
}

/**
 * server-a 의 IssueRequestService 에서 사용. B 호출 결과를 A 가 사용자에게 전달하기 위한 형.
 * (Kafka 가 아니라 A↔B HTTP 응답 형태)
 */
export interface IssueAcceptanceResult {
  requestId: string | null;
  status: IssueAcceptanceStatus;
  message: string | null;
}

export const IssueAcceptance = {
  accepted(requestId: string): IssueAcceptanceResult {
    return { requestId, status: 'ACCEPTED', message: null };
  },
  duplicate(requestId: string): IssueAcceptanceResult {
    return {
      requestId,
      status: 'DUPLICATE',
      message: 'already requested for this coupon type',
    };
  },
  /**
   * SOLD_OUT 단락 — Redis pending 적재 없이 즉시 반환되므로 추적 가능한 requestId 가 없다 (null).
   * 사용자는 폴링/내쿠폰 조회 동선이 필요 없음 (응답 자체가 종결).
   */
  soldOut(): IssueAcceptanceResult {
    return { requestId: null, status: 'SOLD_OUT', message: 'coupon sold out' };
  },
  internalError(reason: string): IssueAcceptanceResult {
    return { requestId: null, status: 'INTERNAL_ERROR', message: reason };
  },
} as const;
