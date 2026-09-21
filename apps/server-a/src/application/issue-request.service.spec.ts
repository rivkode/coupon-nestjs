import { IssueAcceptance } from '@app/common';
import { IssueRequest } from '../domain/issue-request';
import type { IssueRequestRepository } from '../domain/issue-request.repository';
import type { CouponAvailabilityCache } from '../infrastructure/redis/coupon-availability.cache';
import type { CouponIssuingClient } from './coupon-issuing.client';
import { IssueCommand } from './issue.command';
import { IssueRequestService } from './issue-request.service';

/**
 * 진입 흐름의 **순서**와 상태 매핑을 고정한다.
 * 매진 확인이 B 호출보다 뒤로 가면 단락의 의미(B/C 자원 절약)가 사라진다.
 */
describe('IssueRequestService — 진입 단락과 상태 매핑', () => {
  function setup() {
    const save = jest.fn().mockImplementation((request: IssueRequest) =>
      Promise.resolve(
        IssueRequest.reconstitute({
          id: 1,
          requestId: request.requestId,
          userId: request.userId,
          eventId: request.eventId,
          couponTypeId: request.couponTypeId,
          status: request.status,
          createdAt: new Date(),
        }),
      ),
    );
    const issue = jest.fn();
    const isSoldOut = jest.fn().mockResolvedValue(false);

    const service = new IssueRequestService(
      { save } as unknown as IssueRequestRepository,
      { issue } as unknown as CouponIssuingClient,
      { isSoldOut } as unknown as CouponAvailabilityCache,
    );
    return { service, save, issue, isSoldOut };
  }

  const command = new IssueCommand(100, 202605, 1);

  it('매진 캐시가 히트하면 B 를 호출하지 않는다', async () => {
    const { service, issue, isSoldOut, save } = setup();
    isSoldOut.mockResolvedValue(true);

    const outcome = await service.issue(command);

    expect(issue).not.toHaveBeenCalled();
    expect(outcome.downstreamStatus).toBe('SOLD_OUT');
    expect(outcome.message).toBe('coupon sold out');
    // 단락된 요청도 감사 로그는 남긴다
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0][0] as IssueRequest).status).toBe('SOLD_OUT');
  });

  it('매진 캐시 조회가 B 호출보다 먼저 일어난다', async () => {
    const { service, issue, isSoldOut } = setup();
    const order: string[] = [];
    isSoldOut.mockImplementation(() => {
      order.push('cache');
      return Promise.resolve(false);
    });
    issue.mockImplementation(() => {
      order.push('client');
      return Promise.resolve(IssueAcceptance.accepted('req-1'));
    });

    await service.issue(command);

    expect(order).toEqual(['cache', 'client']);
  });

  it.each([
    ['ACCEPTED', 'ACCEPTED'],
    ['DUPLICATE', 'DUPLICATE'],
    ['SOLD_OUT', 'SOLD_OUT'],
    ['INTERNAL_ERROR', 'REJECTED'],
  ])('B 응답 %s 는 감사 로그에 %s 로 기록된다', async (downstream, logged) => {
    const { service, issue, save } = setup();
    issue.mockResolvedValue({
      requestId: 'req-1',
      status: downstream,
      message: null,
    });

    const outcome = await service.issue(command);

    expect((save.mock.calls[0][0] as IssueRequest).status).toBe(logged);
    expect(outcome.downstreamStatus).toBe(downstream);
  });

  it('INTERNAL_ERROR 면 503 으로 응답해야 한다고 알린다', async () => {
    const { service, issue } = setup();
    issue.mockResolvedValue(IssueAcceptance.internalError('circuit-open'));

    const outcome = await service.issue(command);

    expect(outcome.isDownstreamUnavailable()).toBe(true);
    expect(outcome.message).toBe('circuit-open');
  });

  it('정상 응답이면 503 이 아니다', async () => {
    const { service, issue } = setup();
    issue.mockResolvedValue(IssueAcceptance.accepted('req-1'));

    const outcome = await service.issue(command);

    expect(outcome.isDownstreamUnavailable()).toBe(false);
  });
});
