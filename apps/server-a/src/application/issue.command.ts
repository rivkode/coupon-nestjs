/** 발급 요청 입력 (원본 `IssueCommand` record). */
export class IssueCommand {
  constructor(
    readonly userId: number,
    readonly eventId: number,
    readonly couponTypeId: number,
  ) {}
}
