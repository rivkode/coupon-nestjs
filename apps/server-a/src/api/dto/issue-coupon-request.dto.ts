import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * 발급 요청 본문 — **10 필드** (api-contract §5).
 *
 * `userId` 는 본문이 아니라 `X-User-Id` 헤더로 전달된다. 본문은 발급 컨텍스트만 담는다.
 *
 * 핵심 식별자(country, eventId, couponTypeId, channel, issuedAt, expireAt)는 필수,
 * 보조 컨텍스트(deviceId, clientVersion, language, marketingConsent)는 선택이다.
 *
 * ⚠️ `issuedAt` / `expireAt` 은 검증만 하고 downstream 으로 넘기지 않는다.
 *    B 로는 `eventId` 와 `couponTypeId` 만 간다.
 */
export class IssueCouponRequestDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(8)
  country!: string;

  @IsNotEmpty()
  @IsInt()
  @IsPositive()
  eventId!: number;

  @IsNotEmpty()
  @IsInt()
  @IsPositive()
  couponTypeId!: number;

  @IsNotEmpty()
  @IsISO8601()
  issuedAt!: string;

  @IsNotEmpty()
  @IsISO8601()
  expireAt!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(32)
  channel!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  clientVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;
}
