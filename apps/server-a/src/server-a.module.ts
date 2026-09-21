import { MetricsController, buildMysqlOptions } from '@app/common';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './api/health.controller';
import { IssueRequestController } from './api/issue-request.controller';
import { CouponIssuingClient } from './application/coupon-issuing.client';
import { IssueRequestService } from './application/issue-request.service';
import { IssueRequestRepository } from './domain/issue-request.repository';
import { HttpCouponIssuingClient } from './infrastructure/client/http-coupon-issuing.client';
import { IssueRequestOrmEntity } from './infrastructure/persistence/issue-request.orm-entity';
import { TypeOrmIssueRequestRepository } from './infrastructure/persistence/typeorm-issue-request.repository';
import { CouponAvailabilityCache } from './infrastructure/redis/coupon-availability.cache';
import { RedisModule } from './infrastructure/redis/redis.module';

/**
 * server-a 루트 모듈 — 진입점.
 *
 * 책임: 진입 · `X-User-Id` 인증 · 매진 단락 · 요청 로그(요청당 커밋) · server-b 호출(Circuit Breaker)
 *
 * ⚠️ **재고를 다루지 않는다.** 재고 권위는 server-c 의 MySQL 비관적 락이다.
 * ⚠️ 긴 트랜잭션을 잡지 않는다. A 는 진입점이다.
 * ⚠️ 사용자별 Rate Limit 을 두지 않는다 — 1인 1장 제약이 자연 차단하고,
 *    Backpressure 는 Kafka consumer throttle 이 담당한다.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () =>
        buildMysqlOptions({
          database: process.env.DB_NAME_A ?? 'server_a',
          port: Number(process.env.DB_PORT_A ?? 3306),
          // glob 금지 — 모노레포에서 다른 앱 엔티티를 빨아들인다.
          entities: [IssueRequestOrmEntity],
          // `[0-9]*` — data-source.js 를 배제한다 (걸리면 TypeORM 디렉터리 로더가 무한 재귀).
          migrations: [`${__dirname}/../../../migrations/server-a/[0-9]*.js`],
        }),
    }),
    // server-b 호출용
    HttpModule,
    RedisModule,
    TerminusModule,
  ],
  controllers: [IssueRequestController, HealthController, MetricsController],
  providers: [
    IssueRequestService,
    CouponAvailabilityCache,
    {
      provide: IssueRequestRepository,
      useClass: TypeOrmIssueRequestRepository,
    },
    { provide: CouponIssuingClient, useClass: HttpCouponIssuingClient },
  ],
})
export class ServerAModule {}
