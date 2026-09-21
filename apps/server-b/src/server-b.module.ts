import { MetricsController } from '@app/common';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { CouponIssueController } from './api/coupon-issue.controller';
import { HealthController } from './api/health.controller';
import { CouponIssueAcceptService } from './application/coupon-issue-accept.service';
import { PendingIssueScheduler } from './application/pending-issue.scheduler';
import { PendingIssueStore } from './domain/pending-issue.store';
import { UserCouponClient } from './infrastructure/client/user-coupon.client';
import { CouponIssueResultConsumer } from './infrastructure/kafka/coupon-issue-result.consumer';
import { IssueRequestPublisher } from './infrastructure/kafka/issue-request.publisher';
import { KafkaModule } from './infrastructure/kafka/kafka.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { RedisPendingIssueStore } from './infrastructure/redis/redis-pending-issue.store';

/**
 * server-b 루트 모듈 — 신청 접수 + 결과 캐시 (원본 `ServerBApplication`).
 *
 * 책임: Redis 에 신청 적재 → 즉시 "접수 완료" 응답 (ADR-001) → Kafka publish (ADR-008)
 *      → result consume 으로 Redis 갱신 (ADR-009) → pending 스케줄러로 회복 (ADR-008)
 *
 * ⚠️ **TypeOrmModule 을 import 하지 않는다** (ADR-006 — b 는 Redis only). 붙이면 설계 위반이다.
 * ⚠️ 재고를 다루지 않는다 — 재고 권위는 server-c 의 MySQL 비관적 락 (ADR-003).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // ADR-008: pending 스케줄러 (@Scheduled fixed-delay 1s 대응)
    ScheduleModule.forRoot(),
    // 스케줄러가 server-c 의 internal GET 을 호출한다.
    HttpModule,
    RedisModule,
    KafkaModule,
    TerminusModule,
  ],
  controllers: [CouponIssueController, HealthController, MetricsController],
  providers: [
    CouponIssueAcceptService,
    PendingIssueScheduler,
    IssueRequestPublisher,
    CouponIssueResultConsumer,
    UserCouponClient,
    { provide: PendingIssueStore, useClass: RedisPendingIssueStore },
  ],
})
export class ServerBModule {}
