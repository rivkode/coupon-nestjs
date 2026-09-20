import { buildMysqlOptions } from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './api/health.controller';

/**
 * server-c 루트 모듈 — 영구 저장 + 재고 권위 (원본 `ServerCApplication`).
 *
 * 책임: Kafka consumer 가 1 트랜잭션 안에서 중복 체크 → 이벤트 유효성 → 비관적 락 재고 차감 (ADR-003)
 *      → user_coupon INSERT → outbox INSERT (ADR-002). publish 는 트랜잭션 밖 OutboxPoller.
 *      redeem 은 낙관적 락 (ADR-007 / ADR-N03). event 조회는 Cache-Aside + Refresh-Ahead.
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
          entities: [],
          // `[0-9]*` — data-source.js 를 배제한다 (걸리면 TypeORM 디렉터리 로더가 무한 재귀).
          migrations: [`${__dirname}/../../../migrations/server-c/[0-9]*.js`],
        }),
    }),
    // ADR-002 OutboxPoller (500ms) + EventCacheRefresher (60s)
    ScheduleModule.forRoot(),
    TerminusModule,
  ],
  controllers: [HealthController],
})
export class ServerCModule {}
