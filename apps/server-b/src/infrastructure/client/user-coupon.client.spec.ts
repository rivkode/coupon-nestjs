import type { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { UserCouponClient } from './user-coupon.client';

/**
 * ⚠️ 이 파일의 첫 테스트는 **실제로 터졌던 버그**를 고정한다.
 *
 * 최초 구현이 `e instanceof AxiosError` 로 404 를 판정했는데, `@nestjs/axios` 를 거치면
 * 에러가 다른 axios 인스턴스에서 생성돼 클래스 비교가 실패했다. 그 결과 "아직 c 가 처리 전"
 * 이라는 **정상 상태**가 전부 "조회 실패" 로 분류되어, 스케줄러가 재발행 단계로 영원히
 * 넘어가지 못했다 (ADR-008 의 30s SLA 가 100% 깨진다).
 */
describe('UserCouponClient — c 의 internal GET 해석', () => {
  function clientWith(get: jest.Mock): UserCouponClient {
    return new UserCouponClient({ get } as unknown as HttpService);
  }

  it('404 는 예외가 아니라 null 이다 — "아직 처리 전" 이라는 정상 상태', async () => {
    // axios 가 만드는 에러의 구조만 흉내낸다 (클래스 동일성에 기대지 않는다)
    const notFound = Object.assign(
      new Error('Request failed with status code 404'),
      {
        response: { status: 404 },
      },
    );
    const client = clientWith(
      jest.fn().mockReturnValue(throwError(() => notFound)),
    );

    await expect(client.findOne(1, 1)).resolves.toBeNull();
  });

  it('5xx 는 그대로 올린다 — 스케줄러가 다음 cycle 에 재시도해야 한다', async () => {
    const serverError = Object.assign(new Error('boom'), {
      response: { status: 500 },
    });
    const client = clientWith(
      jest.fn().mockReturnValue(throwError(() => serverError)),
    );

    await expect(client.findOne(1, 1)).rejects.toThrow('boom');
  });

  it('연결 실패(response 없음)도 그대로 올린다', async () => {
    const connError = new Error('ECONNREFUSED');
    const client = clientWith(
      jest.fn().mockReturnValue(throwError(() => connError)),
    );

    await expect(client.findOne(1, 1)).rejects.toThrow('ECONNREFUSED');
  });

  it('200 이면 봉투의 data 를 꺼낸다', async () => {
    const data = {
      userId: 7,
      eventId: 1,
      couponTypeId: 1,
      code: 'ABCDEFGHJKMN',
      status: 'SUCCESS',
    };
    const client = clientWith(
      jest.fn().mockReturnValue(of({ data: { success: true, data } })),
    );

    await expect(client.findOne(7, 1)).resolves.toEqual(data);
  });

  it('봉투는 왔지만 data 가 없으면 null', async () => {
    const client = clientWith(
      jest.fn().mockReturnValue(of({ data: { success: true } })),
    );

    await expect(client.findOne(7, 1)).resolves.toBeNull();
  });
});
