import type { IssueAcceptanceResult } from '@app/common';

/**
 * server-a → server-b 호출 포트 (원본 `CouponIssuingClient`).
 *
 * 구현은 `infrastructure/client` 에 있다. 이 계층에 포트를 두는 이유는
 * 이 호출이 리포지토리가 아니라 **외부 서비스 의존**이고, 필요로 하는 쪽이 application 이기 때문이다.
 */
export abstract class CouponIssuingClient {
  abstract issue(
    userId: number,
    eventId: number,
    couponTypeId: number,
  ): Promise<IssueAcceptanceResult>;
}
