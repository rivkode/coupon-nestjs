/** newlyRedeemed=false 면 같은 user 의 멱등 재호출 (원본 `RedeemResult` record). */
export class RedeemResult {
  private constructor(
    readonly code: string,
    readonly userId: number,
    readonly redeemedAt: Date,
    readonly newlyRedeemed: boolean,
  ) {}

  /** 본 호출에서 USED 로 전이. */
  static succeeded(
    code: string,
    userId: number,
    redeemedAt: Date,
  ): RedeemResult {
    return new RedeemResult(code, userId, redeemedAt, true);
  }

  /** 이미 USED — `redeemedAt` 은 **최초 사용 시각 그대로** 돌려준다. */
  static alreadyRedeemed(
    code: string,
    userId: number,
    redeemedAt: Date,
  ): RedeemResult {
    return new RedeemResult(code, userId, redeemedAt, false);
  }
}
