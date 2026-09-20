import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './api/health.controller';

/**
 * server-b 루트 모듈 — 신청 접수 + 결과 캐시 (원본 `ServerBApplication`).
 *
 * 책임: Redis 에 신청 적재 → 즉시 "접수 완료" 응답 (ADR-001) → Kafka publish (ADR-008)
 *      → result consume 으로 Redis 갱신 (ADR-009) → pending 스케줄러로 회복 (ADR-008)
 *
 * ⚠️ **MySQL 을 붙이지 않는다** (ADR-006 — b 는 Redis only). TypeOrmModule 을 import 하면 설계 위반.
 * ⚠️ 재고를 다루지 않는다 — 재고 권위는 server-c 의 MySQL 비관적 락 (ADR-003).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // ADR-008: pending 스케줄러 (@Scheduled fixed-delay 1s 대응)
    ScheduleModule.forRoot(),
    TerminusModule,
  ],
  controllers: [HealthController],
})
export class ServerBModule {}
