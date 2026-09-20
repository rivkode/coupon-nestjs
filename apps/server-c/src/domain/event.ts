import type { EventStatus } from './statuses';

/** 이벤트 애그리거트. 발급 트랜잭션의 유효성 검사(`isActive`)가 유일한 규칙이다. */
export class Event {
  private constructor(
    readonly id: number,
    readonly name: string,
    readonly content: string | null,
    readonly startedAt: Date,
    readonly endedAt: Date,
    readonly status: EventStatus,
  ) {}

  static reconstitute(params: {
    id: number;
    name: string;
    content: string | null;
    startedAt: Date;
    endedAt: Date;
    status: EventStatus;
  }): Event {
    return new Event(
      params.id,
      params.name,
      params.content,
      params.startedAt,
      params.endedAt,
      params.status,
    );
  }

  /**
   * `started_at <= now <= ended_at` — 원본 `EventJpaEntity#isActive` 와 동일하게 **양 끝 포함**.
   * ⚠️ `status` 는 보지 않는다. 원본도 시간만 본다 (status 는 캐시 갱신 대상 선별에만 쓰인다).
   */
  isActive(now: Date): boolean {
    return (
      now.getTime() >= this.startedAt.getTime() &&
      now.getTime() <= this.endedAt.getTime()
    );
  }
}
