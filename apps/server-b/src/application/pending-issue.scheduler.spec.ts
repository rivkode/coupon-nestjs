import type { PendingIssue } from '../domain/pending-issue';
import type { PendingIssueStore } from '../domain/pending-issue.store';
import type { UserCouponClient } from '../infrastructure/client/user-coupon.client';
import type { IssueRequestPublisher } from '../infrastructure/kafka/issue-request.publisher';
import { PendingIssueScheduler } from './pending-issue.scheduler';

/**
 * ADR-008 의 3분기를 고정한다. 순서와 **카운터 증가 시점**이 30s SLA 의 근거다.
 */
describe('PendingIssueScheduler — ADR-008 3분기', () => {
  const basePending: PendingIssue = {
    requestId: 'req-1',
    userId: 100,
    eventId: 202605,
    couponTypeId: 1,
    status: 'PENDING',
    createdAt: new Date('2026-05-10T00:00:00.000Z'),
    publishAttempts: 1,
  };

  function setup(pending: PendingIssue = basePending) {
    // 목을 지역 변수로 들고 쓴다 — 객체 프로퍼티로 꺼내 쓰면 lint(unbound-method)가 걸린다.
    const findPendingOlderThan = jest.fn().mockResolvedValue([pending]);
    const markResult = jest.fn().mockResolvedValue(undefined);
    const recordRepublish = jest
      .fn()
      .mockResolvedValue(pending.publishAttempts + 1);
    const findOne = jest.fn();
    const publishForScheduler = jest.fn().mockResolvedValue(undefined);

    const scheduler = new PendingIssueScheduler(
      {
        findPendingOlderThan,
        markResult,
        recordRepublish,
        savePendingIfAbsent: jest.fn(),
      } as unknown as PendingIssueStore,
      { findOne } as unknown as UserCouponClient,
      { publishForScheduler } as unknown as IssueRequestPublisher,
    );

    return {
      scheduler,
      markResult,
      recordRepublish,
      findOne,
      publishForScheduler,
    };
  }

  it('① c 가 이미 처리했으면 결과를 동기화하고 재발행하지 않는다', async () => {
    const { scheduler, markResult, findOne, publishForScheduler } = setup();
    findOne.mockResolvedValue({
      userId: 100,
      eventId: 202605,
      couponTypeId: 1,
      code: 'ABCDEFGHJKMN',
      status: 'SUCCESS',
    });

    await scheduler.run();

    expect(markResult).toHaveBeenCalledWith(100, 1, 'SUCCESS', 'ABCDEFGHJKMN');
    expect(publishForScheduler).not.toHaveBeenCalled();
  });

  it('① c 의 USED 는 SUCCESS 로 매핑한다 (이미 써버렸어도 발급은 성공한 것)', async () => {
    const { scheduler, markResult, findOne } = setup();
    findOne.mockResolvedValue({
      userId: 100,
      eventId: 202605,
      couponTypeId: 1,
      code: 'ABCDEFGHJKMN',
      status: 'USED',
    });

    await scheduler.run();

    expect(markResult).toHaveBeenCalledWith(100, 1, 'SUCCESS', 'ABCDEFGHJKMN');
  });

  it('② c 가 모르고 attempts < max 면 재발행한다', async () => {
    const {
      scheduler,
      markResult,
      recordRepublish,
      findOne,
      publishForScheduler,
    } = setup();
    findOne.mockResolvedValue(null);

    await scheduler.run();

    expect(recordRepublish).toHaveBeenCalledWith(100, 1, expect.any(Date));
    expect(publishForScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        userId: 100,
        // 재발행에도 **최초 createdAt** 을 그대로 싣는다 (요청 시각의 의미 유지)
        requestedAt: '2026-05-10T00:00:00Z',
      }),
    );
    expect(markResult).not.toHaveBeenCalled();
  });

  it('② 카운터는 publish 시도 직전에 증가한다 — publish 가 실패해도 cap 이 수렴해야 한다', async () => {
    const {
      scheduler,
      markResult,
      recordRepublish,
      findOne,
      publishForScheduler,
    } = setup();
    findOne.mockResolvedValue(null);
    publishForScheduler.mockRejectedValue(new Error('broker down'));

    await scheduler.run();

    // publish 가 throw 해도 attempts 는 이미 증가했다 → 무한 cycle 방지
    expect(recordRepublish).toHaveBeenCalledTimes(1);
    // 예외가 밖으로 새지 않는다 (다음 cycle 이 살아야 한다)
    expect(markResult).not.toHaveBeenCalled();
  });

  it('③ attempts 가 cap(3) 에 도달하면 FAILED 로 마감한다', async () => {
    const { scheduler, markResult, findOne, publishForScheduler } = setup({
      ...basePending,
      publishAttempts: 3,
    });
    findOne.mockResolvedValue(null);

    await scheduler.run();

    expect(markResult).toHaveBeenCalledWith(100, 1, 'FAILED', null);
    expect(publishForScheduler).not.toHaveBeenCalled();
  });

  it('c lookup 이 실패하면 zset 을 건드리지 않고 다음 cycle 로 넘긴다', async () => {
    const {
      scheduler,
      markResult,
      recordRepublish,
      findOne,
      publishForScheduler,
    } = setup();
    findOne.mockRejectedValue(new Error('timeout'));

    await scheduler.run();

    expect(markResult).not.toHaveBeenCalled();
    expect(recordRepublish).not.toHaveBeenCalled();
    expect(publishForScheduler).not.toHaveBeenCalled();
  });
});
