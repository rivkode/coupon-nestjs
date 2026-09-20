import { toLocalDateTimeString } from '@app/common';
import type { RedeemResult } from '../application/redeem.result';

/**
 * `POST /api/v1/coupons/{code}/redeem` 응답 (원본 `RedeemCouponResponse`).
 *
 * `newlyRedeemed: false` 면 같은 user 의 멱등 replay 이고, `redeemedAt` 은 최초 사용 시각이다.
 */
export interface RedeemCouponView {
  code: string;
  userId: number;
  redeemedAt: string;
  newlyRedeemed: boolean;
}

export function toRedeemView(result: RedeemResult): RedeemCouponView {
  return {
    code: result.code,
    userId: result.userId,
    redeemedAt: toLocalDateTimeString(result.redeemedAt),
    newlyRedeemed: result.newlyRedeemed,
  };
}
