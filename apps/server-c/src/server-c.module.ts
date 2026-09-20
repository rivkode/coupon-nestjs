import { buildMysqlOptions } from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventQueryController } from './api/event-query.controller';
import { HealthController } from './api/health.controller';
import { RedeemCouponController } from './api/redeem-coupon.controller';
import { UserCouponController } from './api/user-coupon.controller';
import { UserCouponInternalController } from './api/user-coupon-internal.controller';
import { CouponIssueProcessor } from './application/coupon-issue.processor';
import { EventCacheRefresher } from './application/event-cache.refresher';
import { EventQueryService } from './application/event-query.service';
import { OutboxPoller } from './application/outbox.poller';
import { RedeemCouponService } from './application/redeem-coupon.service';
import { UserCouponQueryService } from './application/user-coupon-query.service';
import { CouponTypeInventoryRepository } from './domain/coupon-type-inventory.repository';
import { EventRepository } from './domain/event.repository';
import { OutboxEventRepository } from './domain/outbox-event.repository';
import { UserCouponRepository } from './domain/user-coupon.repository';
import { CouponIssueRequestConsumer } from './infrastructure/kafka/coupon-issue-request.consumer';
import { IssueResultPublisher } from './infrastructure/kafka/issue-result.publisher';
import { KafkaModule } from './infrastructure/kafka/kafka.module';
import { CouponTypeInventoryOrmEntity } from './infrastructure/persistence/coupon-type-inventory.orm-entity';
import { CouponTypeOrmEntity } from './infrastructure/persistence/coupon-type.orm-entity';
import { EventOrmEntity } from './infrastructure/persistence/event.orm-entity';
import { OutboxEventOrmEntity } from './infrastructure/persistence/outbox-event.orm-entity';
import { TypeOrmCouponTypeInventoryRepository } from './infrastructure/persistence/typeorm-coupon-type-inventory.repository';
import { TypeOrmEventRepository } from './infrastructure/persistence/typeorm-event.repository';
import { TypeOrmOutboxEventRepository } from './infrastructure/persistence/typeorm-outbox-event.repository';
import { TypeOrmUserCouponRepository } from './infrastructure/persistence/typeorm-user-coupon.repository';
import { UserCouponOrmEntity } from './infrastructure/persistence/user-coupon.orm-entity';
import { CouponAvailabilityCache } from './infrastructure/redis/coupon-availability.cache';
import { EventCacheStore } from './infrastructure/redis/event-cache.store';
import { RedisModule } from './infrastructure/redis/redis.module';

/**
 * server-c 루트 모듈 — 영구 저장 + 재고 권위 (원본 `ServerCApplication`).
 *
 * 책임: Kafka consumer 가 1 트랜잭션 안에서 중복 체크 → 이벤트 유효성 → 비관적 락 재고 차감 (ADR-003)
 *      → user_coupon INSERT → outbox INSERT (ADR-002). publish 는 트랜잭션 밖 OutboxPoller.
 *      redeem 은 낙관적 락 (ADR-007 / ADR-N03). event 조회는 Cache-Aside + Refresh-Ahead.
 *
 * 리포지토리는 `domain/` 의 abstract class 를 토큰으로 바인딩한다 (nest-ddd-layering §2) —
 * 애플리케이션 서비스는 구현체를 모른다.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () =>
        buildMysqlOptions({
          database: process.env.DB_NAME_C ?? 'server_c',
          port: Number(process.env.DB_PORT_C ?? 3307),
          // ADR-N05: glob 금지 — 모노레포에서 다른 앱 엔티티를 빨아들인다.
          entities: [
            EventOrmEntity,
            CouponTypeOrmEntity,
            CouponTypeInventoryOrmEntity,
            UserCouponOrmEntity,
            OutboxEventOrmEntity,
          ],
          // `[0-9]*` — data-source.js 를 배제한다 (걸리면 TypeORM 디렉터리 로더가 무한 재귀).
          migrations: [`${__dirname}/../../../migrations/server-c/[0-9]*.js`],
        }),
    }),
    // ADR-002 OutboxPoller (500ms) + EventCacheRefresher (60s)
    ScheduleModule.forRoot(),
    RedisModule,
    KafkaModule,
    TerminusModule,
  ],
  controllers: [
    RedeemCouponController,
    UserCouponController,
    UserCouponInternalController,
    EventQueryController,
    HealthController,
  ],
  providers: [
    // application
    CouponIssueProcessor,
    RedeemCouponService,
    EventQueryService,
    UserCouponQueryService,
    OutboxPoller,
    EventCacheRefresher,
    // infrastructure — redis / kafka
    EventCacheStore,
    CouponAvailabilityCache,
    IssueResultPublisher,
    CouponIssueRequestConsumer,
    // domain 추상 → TypeORM 구현 바인딩
    { provide: UserCouponRepository, useClass: TypeOrmUserCouponRepository },
    {
      provide: CouponTypeInventoryRepository,
      useClass: TypeOrmCouponTypeInventoryRepository,
    },
    { provide: EventRepository, useClass: TypeOrmEventRepository },
    { provide: OutboxEventRepository, useClass: TypeOrmOutboxEventRepository },
  ],
})
export class ServerCModule {}
