import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

/** server-c 의 internal GET 응답 `data` (spec-parity §2 #6 — 봉투를 사용한다). */
export interface UserCouponLookupResult {
  userId: number;
  eventId: number;
  couponTypeId: number;
  code: string;
  /** `SUCCESS` / `SOLD_OUT` / `FAILED` / `USED` */
  status: string;
}

interface Envelope {
  success: boolean;
  data?: UserCouponLookupResult;
}

/**
 * server-c 의 internal GET 호출 (원본 `UserCouponClient.Lookup`).
 * `PendingIssueScheduler` 가 ADR-008 의 1단계(“C 가 이미 처리했는가”)에서 쓴다.
 *
 * 원본 yml: `app.server-c.base-url`, `timeout-ms: 1500`
 *
 * ⚠️ **미이관**: 원본은 connect timeout 과 read timeout 을 나눠 잡는다
 *    (`connectTimeout = min(timeoutMs, 1000)`, `readTimeout = 1500`).
 *    axios 에는 연결 타임아웃 개념이 따로 없어 `timeout: 1500` 하나만 건다 —
 *    연결 지연 상한이 1000ms → 1500ms 로 늘어난다.
 *
 * **404 는 예외가 아니라 `null`** 이다 — "아직 처리 전" 이라는 정상 상태이고,
 * 스케줄러는 다음 단계(재발행)로 넘어가야 한다.
 */
@Injectable()
export class UserCouponClient {
  private readonly logger = new Logger(UserCouponClient.name);
  private readonly baseUrl =
    process.env.SERVER_C_URL ?? 'http://localhost:8082';
  private readonly timeoutMs = Number(process.env.SERVER_C_TIMEOUT_MS ?? 1500);

  constructor(private readonly http: HttpService) {}

  async findOne(
    userId: number,
    couponTypeId: number,
  ): Promise<UserCouponLookupResult | null> {
    try {
      const response = await firstValueFrom(
        this.http.get<Envelope>(
          `${this.baseUrl}/internal/v1/users/${userId}/coupons/${couponTypeId}`,
          { timeout: this.timeoutMs },
        ),
      );
      return response.data?.data ?? null;
    } catch (e) {
      if (httpStatusOf(e) === 404) {
        // 아직 c 가 처리하지 않았다 — 정상 흐름. 스케줄러는 재발행 단계로 넘어가야 한다.
        return null;
      }
      // 그 외(타임아웃, 5xx, 연결 실패)는 올린다 → 스케줄러가 다음 cycle 에 재시도.
      throw e;
    }
  }
}

/**
 * 응답 상태코드를 **구조적으로** 읽는다.
 *
 * ⚠️ `e instanceof AxiosError` 를 쓰면 안 된다. `@nestjs/axios` 를 거치면 에러가 다른 axios
 *    인스턴스에서 생성될 수 있어 클래스 동일성 비교가 실패한다 — 실제로 404 가 `null` 로
 *    변환되지 않아 스케줄러가 재발행 단계로 넘어가지 못하는 버그가 났다.
 *    (원본 Java 의 `catch (HttpClientErrorException.NotFound)` 는 이런 문제가 없다.)
 */
function httpStatusOf(e: unknown): number | undefined {
  return (e as { response?: { status?: number } } | null | undefined)?.response
    ?.status;
}
