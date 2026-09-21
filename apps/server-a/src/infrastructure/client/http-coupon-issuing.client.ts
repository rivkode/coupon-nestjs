import {
  IssueAcceptance,
  type IssueAcceptanceResult,
  type IssueAcceptanceStatus,
} from '@app/common';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import {
  BrokenCircuitError,
  CountBreaker,
  ExponentialBackoff,
  circuitBreaker,
  handleAll,
  retry,
  wrap,
} from 'cockatiel';
import { firstValueFrom } from 'rxjs';
import { CouponIssuingClient } from '../../application/coupon-issuing.client';

/** server-b 의 raw 응답 (봉투 없음 — api-contract §2/§3). */
interface IssueResponsePayload {
  requestId?: string;
  status?: IssueAcceptanceStatus;
  message?: string;
}

/**
 * server-b `POST /internal/v1/coupons/issue` 호출.
 *
 * ## Circuit Breaker + Retry 수치는 부하 테스트 산물이다
 *
 * 원본 `application.yml` 주석이 근거를 남겨 두었다 — retry 3회 + slow-call 500ms 조합이
 * **부하 증폭의 결정적 요인**이었다 (1초 timeout × 3 호출 = 3초 응답 → server-b 부하 3배 →
 * slow-call 증가 → CB 트립). 균형점으로 retry 는 transient 한 번만 흡수하고,
 * CB 는 read-timeout 의 80% 임계로 완화했다. **기본값으로 갈아엎지 말 것.**
 *
 * ## Resilience4j → cockatiel 매핑
 *
 * | Resilience4j | cockatiel | 비고 |
 * |---|---|---|
 * | `sliding-window-type: COUNT_BASED` | `CountBreaker` | 정확히 대응 |
 * | `sliding-window-size: 20` | `size: 20` | |
 * | `failure-rate-threshold: 50` | `threshold: 0.5` | |
 * | `minimum-number-of-calls: 10` | `minimumNumberOfCalls: 10` | |
 * | `wait-duration-in-open-state: 5s` | `halfOpenAfter: 5000` | |
 * | `slow-call-duration-threshold: 800ms` | `orWhenResult(느림)` | 아래 참고 |
 * | `max-attempts: 2` (총 2회 호출) | `maxAttempts: 1` (재시도 1회) | 의미가 다르니 주의 |
 * | `wait-duration: 50ms`, 지수 ×2 | `ExponentialBackoff({ initialDelay: 50 })` | |
 * | `permitted-number-of-calls-in-half-open-state: 3` | — | **미이관** (cockatiel 은 1건 고정) |
 *
 * ### slow call 을 결과 조건으로 다루는 이유
 *
 * Resilience4j 는 느린 호출을 **실패로 집계하되 응답은 그대로 돌려준다**.
 * cockatiel 의 `timeout` 정책을 쓰면 800ms 에서 요청을 끊어버려 사용자 응답이 달라진다.
 * 그래서 소요 시간을 함께 반환하고 `orWhenResult` 로 "느린 결과 = 실패" 를 표시한다 —
 * breaker 는 실패로 집계하지만 값은 그대로 반환된다 (cockatiel 의 `returnOrThrow`).
 */
@Injectable()
export class HttpCouponIssuingClient extends CouponIssuingClient {
  private readonly logger = new Logger(HttpCouponIssuingClient.name);

  private readonly baseUrl =
    process.env.SERVER_B_URL ?? 'http://localhost:8081';
  /**
   * 원본 `read-timeout-millis: 1000`. 측정 결과 500ms 는 1,000 TPS 부하에서 slow-call 로 분류되어
   * CB 가 false-positive 로 열렸다. 응답 모델이 "접수 완료" 라 1초 지연을 허용한다.
   */
  private readonly readTimeoutMs = Number(
    process.env.SERVER_B_READ_TIMEOUT_MS ?? 1000,
  );
  /** read-timeout 의 80% — 일시 spike 는 흡수하고 진짜 timeout 만 느림으로 분류한다. */
  private readonly slowCallThresholdMs = Number(
    process.env.SERVER_B_SLOW_CALL_MS ?? 800,
  );

  private readonly policy = wrap(
    // 바깥: Circuit Breaker — 느린 결과도 실패로 집계한다.
    circuitBreaker(
      handleAll.orWhenResult(
        (r) => (r as TimedResult).elapsedMs > this.slowCallThresholdMs,
      ),
      {
        halfOpenAfter: Number(process.env.SERVER_B_CB_OPEN_MS ?? 5000),
        breaker: new CountBreaker({
          threshold: 0.5,
          size: 20,
          minimumNumberOfCalls: 10,
        }),
      },
    ),
    // 안쪽: Retry — transient 실패(네트워크 blip, B 의 GC pause 1회)만 흡수한다.
    // maxAttempts 는 **재시도 횟수**다. 원본의 max-attempts: 2 = 총 2회 호출 = 재시도 1회.
    retry(handleAll, {
      maxAttempts: 1,
      backoff: new ExponentialBackoff({ initialDelay: 50, maxDelay: 200 }),
    }),
  );

  constructor(private readonly http: HttpService) {
    super();
  }

  async issue(
    userId: number,
    eventId: number,
    couponTypeId: number,
  ): Promise<IssueAcceptanceResult> {
    try {
      const timed = await this.policy.execute(() =>
        this.call(userId, eventId, couponTypeId),
      );
      return timed.result;
    } catch (e) {
      return this.fallback(userId, couponTypeId, e);
    }
  }

  private async call(
    userId: number,
    eventId: number,
    couponTypeId: number,
  ): Promise<TimedResult> {
    const startedAt = Date.now();
    const response = await firstValueFrom(
      this.http.post<IssueResponsePayload>(
        `${this.baseUrl}/internal/v1/coupons/issue`,
        { eventId, couponTypeId },
        {
          headers: { 'X-User-Id': String(userId) },
          timeout: this.readTimeoutMs,
          // ⚠️ axios 에는 connect timeout 개념이 따로 없다.
          // 원본의 `connect-timeout-millis: 1000` 은 **미이관** — read timeout 하나로 합쳐진다.
        },
      ),
    );
    const elapsedMs = Date.now() - startedAt;

    const body = response.data;
    if (body?.status == null) {
      this.logger.warn(
        `server-b empty body: userId=${userId} couponTypeId=${couponTypeId}`,
      );
      return {
        elapsedMs,
        result: IssueAcceptance.internalError('empty-response'),
      };
    }

    return {
      elapsedMs,
      result: {
        requestId: body.requestId ?? null,
        status: body.status,
        message: body.message ?? null,
      },
    };
  }

  /**
   * 원본 `issueFallback` 과 같은 세 가지 메시지를 만든다. 이 문자열은 503 응답 본문에 실린다
   * (api-contract §1).
   */
  private fallback(
    userId: number,
    couponTypeId: number,
    error: unknown,
  ): IssueAcceptanceResult {
    if (error instanceof BrokenCircuitError) {
      this.logger.warn(
        `circuit OPEN: userId=${userId} couponTypeId=${couponTypeId}`,
      );
      return IssueAcceptance.internalError('circuit-open');
    }

    const status = (error as { response?: { status?: number } } | null)
      ?.response?.status;
    if (status !== undefined) {
      this.logger.warn(
        `server-b status=${status}: userId=${userId} couponTypeId=${couponTypeId}`,
      );
      return IssueAcceptance.internalError(`server-b-status:${status}`);
    }

    const name = error instanceof Error ? error.constructor.name : 'Error';
    this.logger.warn(
      `server-b call failed: userId=${userId} couponTypeId=${couponTypeId} reason=${String(error)}`,
    );
    return IssueAcceptance.internalError(`downstream-error:${name}`);
  }
}

/** 소요 시간을 함께 실어 breaker 가 "느린 호출" 을 판정할 수 있게 한다. */
interface TimedResult {
  elapsedMs: number;
  result: IssueAcceptanceResult;
}
