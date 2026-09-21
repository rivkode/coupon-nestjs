import type { Kafka } from 'kafkajs';
import type { PendingIssueStore } from '../../domain/pending-issue.store';
import { CouponIssueResultConsumer } from './coupon-issue-result.consumer';

/**
 * consumer **설정 자체**를 고정하는 회귀 테스트.
 *
 * 여기 있는 세 옵션은 하나만 틀려도 조용히 데이터가 사라지거나 오프셋이 안 남는다.
 * 실제로 첫 구현이 둘 다 틀렸고, 통합 테스트로는 배치가 작아 드러나지 않았다.
 */
describe('CouponIssueResultConsumer — ADR-009 throttle 설정 (server-b)', () => {
  function setup() {
    const runOptions: Record<string, unknown> = {};
    const consumerStub = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      run: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
        Object.assign(runOptions, opts);
        return Promise.resolve();
      }),
    };
    const consumerFactory = jest.fn().mockReturnValue(consumerStub);
    const kafka = { consumer: consumerFactory } as unknown as Kafka;
    const store = { markResult: jest.fn() } as unknown as PendingIssueStore;

    return {
      consumer: new CouponIssueResultConsumer(kafka, store),
      runOptions,
      consumerStub,
      consumerFactory,
    };
  }

  it('eachBatchAutoResolve 가 false 다 — true 면 throttle 로 건너뛴 레코드가 영구 유실된다', async () => {
    const { consumer, runOptions } = setup();
    consumer.onModuleInit();
    await consumer.whenStarted();

    // kafkajs 기본값이 true 이고, true 면 eachBatch 종료 시 batch.lastOffset() 을 통째로 resolve 한다
    expect(runOptions.eachBatchAutoResolve).toBe(false);
  });

  it('autoCommit + threshold 1 로 ack-mode RECORD 를 만든다 — autoCommit:false 면 오프셋이 영원히 커밋되지 않는다', async () => {
    const { consumer, runOptions } = setup();
    consumer.onModuleInit();
    await consumer.whenStarted();

    expect(runOptions.autoCommit).toBe(true);
    expect(runOptions.autoCommitThreshold).toBe(1);
  });

  it('partitionsConsumedConcurrently 가 원본 listener.concurrency(1) 와 같다', async () => {
    const { consumer, runOptions } = setup();
    consumer.onModuleInit();
    await consumer.whenStarted();

    expect(runOptions.partitionsConsumedConcurrently).toBe(1);
  });

  it('server-b 의 group-id 는 coupon-result-server-b 다 (c 와 다르다)', async () => {
    const { consumer, consumerFactory } = setup();
    consumer.onModuleInit();
    await consumer.whenStarted();

    expect(consumerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'coupon-result-server-b' }),
    );
  });

  it('group-id / earliest / max.poll.interval 이 원본 yml 과 같다', async () => {
    const { consumer, consumerFactory, consumerStub } = setup();
    consumer.onModuleInit();
    await consumer.whenStarted();

    expect(consumerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'coupon-result-server-b',
        sessionTimeout: 45000,
        rebalanceTimeout: 300000,
      }),
    );
    expect(consumerStub.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ fromBeginning: true }),
    );
  });
});
