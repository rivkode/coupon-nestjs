import { IsInt, IsNotEmpty, IsPositive } from 'class-validator';

/**
 * server-a 가 호출하는 internal 발급 요청 본문 (원본 `IssueRequest` record).
 * `userId` 는 `X-User-Id` 헤더로 전달된다 (헤더 일관성).
 *
 * 필드는 이 둘뿐이다 — 사용자 요청 본문의 10필드는 server-a 에서 소비하고 b 로는 넘기지 않는다
 * (spec-parity §5).
 */
export class IssueRequestDto {
  @IsNotEmpty()
  @IsInt()
  @IsPositive()
  eventId!: number;

  @IsNotEmpty()
  @IsInt()
  @IsPositive()
  couponTypeId!: number;
}
