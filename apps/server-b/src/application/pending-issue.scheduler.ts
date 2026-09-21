import {
  counter,
  toInstantString,
  type CouponIssueRequestPayload,
} from '@app/common';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { PendingIssue } from '../domain/pending-issue';
import { PendingIssueStore } from '../domain/pending-issue.store';
import type { IssuePendingStatus } from '../domain/statuses';
import { UserCouponClient } from '../infrastructure/client/user-coupon.client';
import { IssueRequestPublisher } from '../infrastructure/kafka/issue-request.publisher';

const FIXED_DELAY_MS = Number(process.env.SCHEDULER_FIXED_DELAY_MS ?? 1000);

/**
 * ADR-008 의 관측 지표. Micrometer 와 같이 **이름당 하나**여야 하므로 모듈 레벨에 둔다
 * (인스턴스 필드로 두면 프로바이더가 두 번 생성될 때 중복 등록으로 터진다).
 * 이름은 Micrometer 의 `pending.scheduler.*` 가 Prometheus 로 노출될 때의 표기를 따른다.
 */
const REPUBLISH_COUNTER = counter(
  'pending_scheduler_republish',
  'ADR-008 — scheduler 의 Kafka 재발행 시도 횟수 (성공/실패 무관)',
);
/** cap 도달로 FAILED 마감한 횟수 — 30s SLA 위반의 관측 지표다. */
const GIVE_UP_COUNTER = counter(
  'pending_scheduler_give_up',
  'ADR-008 — publishAttempts cap 도달로 FAILED 마감한 횟수',
);

/**
 * ADR-008 보완 스케줄러 (원본 `PendingIssueScheduler`).
 *
 * cutoff 초과 PENDING 신청에 대해 **이 순서 그대로**:
 *  1. c 의 internal GET 으로 결과 조회 → 발견되면 Redis 결과 동기화 (Mode B/C 회복)
 *  2. c 가 모르고 `publishAttempts < max` 면 Kafka 재발행 + 카운터 INCR (Mode A 회복)
 *  3. `publishAttempts` 가 cap 에 도달하면 FAILED 마감
 *
 * ⚠️ **카운터를 publish 시도 직전에 증가**시킨다. 그래야 영구 publish 장애에서도 cap 이 수렴해
 *    cutoff(10s) × max(3) = **30초 안에 결론**(SUCCESS 또는 FAILED)이 보장된다.
 *    시도 후 publish 가 throw 하면 zset 에 그대로 두고 다음 cycle 이 재시도하지만,
 *    카운터는 이미 증가했으므로 무한 cycle 이 되지 않는다.
 *
 * ⚠️ 전제: **단일 server-b 인스턴스** (ADR-008). 다중 인스턴스에서는 `ZRANGEBYSCORE` 가
 *    같은 항목을 동시에 잡을 수 있어 cap 의 의미가 약해진다 (정합성은 c 의 UNIQUE 가 보호).
 */
@Injectable()
export class PendingIssueScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PendingIssueScheduler.name);

  private readonly cutoffSeconds = Number(
    process.env.SCHEDULER_PENDING_CUTOFF_SECONDS ?? 10,
  );
  private readonly batchSize = Number(process.env.SCHEDULER_BATCH_SIZE ?? 50);
  private readonly maxPublishAttempts = Number(
    process.env.SCHEDULER_MAX_PUBLISH_ATTEMPTS ?? 3,
  );

  /** 이전 cycle 이 안 끝났는데 다음 cycle 이 겹쳐 도는 것을 막는다 (Node 는 단일 이벤트 루프). */
  private running = false;

  constructor(
    private readonly store: PendingIssueStore,
    private readonly lookup: UserCouponClient,
    private readonly publisher: IssueRequestPublisher,
  ) {}

  /**
   * Spring `fixedDelay` 는 기동 직후 1회 실행한다 — `@Interval` 은 안 돌아서 맞춰준다.
   *
   * ⚠️ **await 하지 않는다.** Nest 는 bootstrap 훅을 await 한 뒤에야 포트를 연다.
   *    첫 cycle 이 느리면(예: stale 50건 × c 호출 1.5s) 그만큼 HTTP 포트가 안 열려
   *    health probe 가 실패한다. Spring 은 별도 스케줄러 스레드라 기동을 막지 않는다.
   */
  onApplicationBootstrap(): void {
    void this.run();
  }

  @Interval(FIXED_DELAY_MS)
  async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.sweep();
    } catch (e) {
      // 주기 작업에서 예외가 새면 이후 tick 이 죽는다. 여기서 반드시 막는다.
      this.logger.error(`scheduler cycle failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<void> {
    const cutoffMs = Date.now() - this.cutoffSeconds * 1000;
    const stale = await this.store.findPendingOlderThan(
      cutoffMs,
      this.batchSize,
    );
    if (stale.length === 0) {
      return;
    }

    for (const pending of stale) {
      try {
        const result = await this.lookup.findOne(
          pending.userId,
          pending.couponTypeId,
        );

        if (result !== null) {
          // Mode B/C — c 는 처리했는데 result 메시지가 유실/지연된 경우.
          const status = mapStatus(result.status);
          await this.store.markResult(
            pending.userId,
            pending.couponTypeId,
            status,
            result.code,
          );
          this.logger.log(
            `scheduler synced from C: userId=${pending.userId}, couponTypeId=${pending.couponTypeId}, status=${status}`,
          );
        } else if (pending.publishAttempts < this.maxPublishAttempts) {
          // Mode A — Kafka 메시지 자체가 c 에 안 닿았다.
          await this.republish(pending);
        } else {
          // 30초 안에 결론을 못 냈다 → FAILED 로 마감.
          await this.store.markResult(
            pending.userId,
            pending.couponTypeId,
            'FAILED',
            null,
          );
          GIVE_UP_COUNTER.inc();
          this.logger.log(
            `scheduler gave up after ${pending.publishAttempts} publish attempts: ` +
              `userId=${pending.userId}, couponTypeId=${pending.couponTypeId}`,
          );
        }
      } catch (e) {
        // c lookup 자체 실패 — 다음 cycle 에 재시도. zset 은 그대로 둔다.
        this.logger.warn(
          `scheduler lookup failed (will retry): userId=${pending.userId}, ` +
            `couponTypeId=${pending.couponTypeId} reason=${String(e)}`,
        );
      }
    }
  }

  private async republish(pending: PendingIssue): Promise<void> {
    // 카운터/score 를 publish **직전에** 갱신해 publish 가 throw 해도 cap 이 수렴하도록 한다.
    const now = new Date();
    const updatedAttempts = await this.store.recordRepublish(
      pending.userId,
      pending.couponTypeId,
      now,
    );
    REPUBLISH_COUNTER.inc();

    const payload: CouponIssueRequestPayload = {
      requestId: pending.requestId,
      userId: pending.userId,
      eventId: pending.eventId,
      couponTypeId: pending.couponTypeId,
      // 원본은 재발행 시에도 **최초 createdAt** 을 그대로 싣는다 (요청 시각의 의미 유지).
      requestedAt: toInstantString(pending.createdAt),
    };

    try {
      await this.publisher.publishForScheduler(payload);
      this.logger.log(
        `scheduler republished: userId=${pending.userId}, ` +
          `couponTypeId=${pending.couponTypeId}, attempts=${updatedAttempts}`,
      );
    } catch (e) {
      // 카운터/score 는 이미 갱신됨 → 다음 cycle 도 시도 가능하지만 cap 까지만.
      this.logger.warn(
        `scheduler republish failed (counter already incremented to ${updatedAttempts}): ` +
          `userId=${pending.userId}, couponTypeId=${pending.couponTypeId} reason=${String(e)}`,
      );
    }
  }
}

/**
 * 원본 `PendingIssueScheduler#mapStatus` — c 의 `UserCouponStatus` 를 Redis 상태로.
 * ⚠️ **`USED` 는 `SUCCESS` 로 매핑**한다 (이미 써버린 쿠폰도 발급은 성공한 것).
 * 알 수 없는 값과 null 은 FAILED.
 */
function mapStatus(cStatus: string | null): IssuePendingStatus {
  switch (cStatus) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'SOLD_OUT':
      return 'SOLD_OUT';
    case 'USED':
      return 'SUCCESS';
    default:
      return 'FAILED';
  }
}
