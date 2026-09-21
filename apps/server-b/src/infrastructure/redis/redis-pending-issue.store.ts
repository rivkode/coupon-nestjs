import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { PendingIssue } from '../../domain/pending-issue';
import { PendingIssueStore } from '../../domain/pending-issue.store';
import type { IssuePendingStatus } from '../../domain/statuses';
import { REDIS_CLIENT } from './redis.module';
import { RedisKeys } from './redis-keys';

/** hash 필드명 — 계약이다 (spec-parity §8). 바꾸면 이미 적재된 신청을 읽지 못한다. */
const F = {
  REQUEST_ID: 'requestId',
  USER_ID: 'userId',
  EVENT_ID: 'eventId',
  COUPON_TYPE_ID: 'couponTypeId',
  STATUS: 'status',
  CREATED_AT: 'createdAt',
  CODE: 'code',
  /** ADR-008 재발행 cap 추적. accept 시 1 로 시작, 스케줄러가 HINCRBY 로 증가. */
  PUBLISH_ATTEMPTS: 'publishAttempts',
  /** ZSET score 와 함께 갱신되어 다음 cycle 의 grace 를 부여. */
  LAST_PUBLISHED_AT: 'lastPublishedAt',
} as const;

/** Redis 자료구조(pending hash + ZSet) 추상화 (원본 `RedisIssueRequestStore`). */
@Injectable()
export class RedisPendingIssueStore extends PendingIssueStore {
  private readonly ttlSeconds = Number(
    process.env.PENDING_TTL_SECONDS ?? 86400,
  );

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  /**
   * `HSETNX` 로 첫 필드(`userId`)만 원자적으로 잡고, 통과한 호출만 나머지 필드 + `ZADD` 를 채운다.
   *
   * `HSETNX → HSET → ZADD` 가 전체로는 원자적이지 않지만, 멱등성의 권위는 server-c 의
   * `(user_id, coupon_type_id)` UNIQUE 라 single-client race 는 무해하다.
   */
  async savePendingIfAbsent(params: {
    requestId: string;
    userId: number;
    eventId: number;
    couponTypeId: number;
    createdAt: Date;
  }): Promise<boolean> {
    const hashKey = RedisKeys.pendingHash(params.userId, params.couponTypeId);
    const createdAtMs = params.createdAt.getTime();

    const firstField = await this.redis.hsetnx(
      hashKey,
      F.USER_ID,
      String(params.userId),
    );
    if (firstField === 0) {
      return false; // 이미 존재 — 중복 신청
    }

    await this.redis.hset(hashKey, {
      [F.REQUEST_ID]: params.requestId,
      [F.USER_ID]: String(params.userId),
      [F.EVENT_ID]: String(params.eventId),
      [F.COUPON_TYPE_ID]: String(params.couponTypeId),
      [F.STATUS]: 'PENDING' satisfies IssuePendingStatus,
      [F.CREATED_AT]: String(createdAtMs),
      [F.PUBLISH_ATTEMPTS]: '1',
      [F.LAST_PUBLISHED_AT]: String(createdAtMs),
    });
    await this.redis.expire(hashKey, this.ttlSeconds);
    await this.redis.zadd(
      RedisKeys.PENDING_ZSET,
      createdAtMs,
      RedisKeys.pendingZsetMember(params.userId, params.couponTypeId),
    );
    return true;
  }

  async recordRepublish(
    userId: number,
    couponTypeId: number,
    publishedAt: Date,
  ): Promise<number> {
    const hashKey = RedisKeys.pendingHash(userId, couponTypeId);
    const publishedAtMs = publishedAt.getTime();

    const updatedAttempts = await this.redis.hincrby(
      hashKey,
      F.PUBLISH_ATTEMPTS,
      1,
    );
    await this.redis.hset(hashKey, F.LAST_PUBLISHED_AT, String(publishedAtMs));
    await this.redis.expire(hashKey, this.ttlSeconds);
    // score 를 밀어 다음 cycle 까지 cutoff 만큼의 grace 를 준다.
    await this.redis.zadd(
      RedisKeys.PENDING_ZSET,
      publishedAtMs,
      RedisKeys.pendingZsetMember(userId, couponTypeId),
    );
    return updatedAttempts;
  }

  async markResult(
    userId: number,
    couponTypeId: number,
    status: IssuePendingStatus,
    code: string | null,
  ): Promise<void> {
    const hashKey = RedisKeys.pendingHash(userId, couponTypeId);

    await this.redis.hset(hashKey, F.STATUS, status);
    if (code !== null) {
      await this.redis.hset(hashKey, F.CODE, code);
    }
    // 사용자 폴링 응답용으로 TTL 동안 유지한다.
    await this.redis.expire(hashKey, this.ttlSeconds);
    // 종료 상태는 zset 에서 제거 — 스케줄러가 다시 잡지 않도록.
    await this.redis.zrem(
      RedisKeys.PENDING_ZSET,
      RedisKeys.pendingZsetMember(userId, couponTypeId),
    );
  }

  async findPendingOlderThan(
    cutoffEpochMs: number,
    batchSize: number,
  ): Promise<PendingIssue[]> {
    const members = await this.redis.zrangebyscore(
      RedisKeys.PENDING_ZSET,
      0,
      cutoffEpochMs,
      'LIMIT',
      0,
      batchSize,
    );
    if (members.length === 0) {
      return [];
    }

    const result: PendingIssue[] = [];
    for (const member of members) {
      const parts = member.split(':');
      if (parts.length !== 2) continue;

      const userId = Number(parts[0]);
      const couponTypeId = Number(parts[1]);
      if (!Number.isFinite(userId) || !Number.isFinite(couponTypeId)) continue;

      const hashKey = RedisKeys.pendingHash(userId, couponTypeId);
      const entries = await this.redis.hgetall(hashKey);
      if (Object.keys(entries).length === 0) {
        // hash 는 TTL 로 사라졌는데 zset member 만 남은 경우 — 고아 항목 정리.
        await this.redis.zrem(RedisKeys.PENDING_ZSET, member);
        continue;
      }

      const requestId = entries[F.REQUEST_ID];
      const eventIdStr = entries[F.EVENT_ID];
      const statusStr = entries[F.STATUS];
      const createdAtStr = entries[F.CREATED_AT];
      if (
        requestId === undefined ||
        eventIdStr === undefined ||
        statusStr === undefined ||
        createdAtStr === undefined
      ) {
        continue;
      }

      // 배포 직후 in-flight 항목은 publishAttempts 필드가 없을 수 있다 → 1 로 해석.
      // 신규 항목 대비 재시도 한도가 한 회 줄지만, server-c 의 UNIQUE 가 안전성을 보호한다.
      const attemptsStr = entries[F.PUBLISH_ATTEMPTS];
      const publishAttempts =
        attemptsStr === undefined ? 1 : Number(attemptsStr);

      result.push({
        requestId,
        userId,
        eventId: Number(eventIdStr),
        couponTypeId,
        status: statusStr as IssuePendingStatus,
        createdAt: new Date(Number(createdAtStr)),
        publishAttempts,
      });
    }
    return result;
  }
}
