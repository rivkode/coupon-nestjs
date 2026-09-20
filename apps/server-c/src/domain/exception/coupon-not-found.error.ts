/** 원본 `serverc/domain/exception/CouponNotFoundException`. code 미존재 + 소유권 마스킹 모두 이 예외. */
export class CouponNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouponNotFoundError';
  }
}
