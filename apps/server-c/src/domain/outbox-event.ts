/**
 * Outbox 레코드 (ADR-002). 도메인 규칙이 없는 **전송 큐**라 애그리거트로 만들지 않고
 * 평범한 읽기/쓰기 타입으로 둔다 (nest-ddd-layering §3).
 */
export interface OutboxRecord {
  id: number;
  /** ⚠️ 발급 결과 이벤트에서는 **requestId** 가 들어간다. Kafka 메시지 key 로도 쓰인다 (spec-parity §9). */
  aggregateId: string;
  eventType: string;
  /** JSON 직렬화된 payload. */
  payload: string;
}

/** 원본 `CouponIssueProcessor` 가 쓰는 유일한 event_type 값. */
export const EVENT_TYPE_ISSUE_RESULT = 'ISSUE_RESULT';
