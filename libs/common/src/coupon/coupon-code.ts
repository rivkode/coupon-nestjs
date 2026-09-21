import { randomInt } from 'node:crypto';
import { InvalidArgumentError } from '../api/errors';

/**
 * 쿠폰 코드 VO. server-c 의 발급 트랜잭션에서 generate() 로 생성하고,
 * `user_coupon.code` 의 UNIQUE constraint 가 유일성의 권위다.
 * 길이 12, 대문자 + 숫자 (Crockford base32 의 일부 — I/L/O/U 제외).
 *
 * ⚠️ SOLD_OUT / FAILED 결과 row 의 placeholder code 는 이 VO 를 거치지 않는다.
 *    원본 `CouponIssueProcessor#generatePlaceholderCode` 가 UUID 조각을 직접 넣으므로
 *    아래 알파벳 규칙을 만족하지 않는다. 의도된 우회이니 검증을 태우지 말 것.
 */
export class CouponCode {
  static readonly LENGTH = 12;
  private static readonly ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

  private constructor(readonly value: string) {}

  /**
   * ⚠️ 예외 종류가 곧 HTTP 상태코드다 (api-contract §4):
   *  - null 검사는 원본이 `Objects.requireNonNull` (= NPE) → 매핑 없음 → **500 INTERNAL_ERROR**
   *  - 길이/문자 검사는 원본이 `IllegalArgumentException` → **400 INVALID_ARGUMENT** (메시지 그대로 노출)
   * 원본 server-c 의 핸들러 javadoc 이 "IllegalArgumentException → 400 (예: CouponCode 길이)" 로 명시한다.
   */
  static of(value: string): CouponCode {
    if (value == null) {
      throw new Error('couponCode value must not be null');
    }
    if (value.length !== CouponCode.LENGTH) {
      throw new InvalidArgumentError(
        `couponCode length must be ${CouponCode.LENGTH} but was ${value.length}`,
      );
    }
    for (const ch of value) {
      if (!CouponCode.ALPHABET.includes(ch)) {
        throw new InvalidArgumentError(
          `couponCode contains invalid character: ${ch}`,
        );
      }
    }
    return new CouponCode(value);
  }

  static generate(): CouponCode {
    let out = '';
    for (let i = 0; i < CouponCode.LENGTH; i++) {
      // randomInt 는 node:crypto 의 CSPRNG — Java SecureRandom 에 대응.
      out += CouponCode.ALPHABET[randomInt(CouponCode.ALPHABET.length)];
    }
    return new CouponCode(out);
  }

  toString(): string {
    return this.value;
  }
}
