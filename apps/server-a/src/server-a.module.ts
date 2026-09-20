import { buildMysqlOptions } from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './api/health.controller';

/**
 * server-a 루트 모듈 — 진입점 (원본 `ServerAApplication`).
 *
 * 책임: 진입 · X-User-Id 인증 · SOLD_OUT 단락 (ADR-011) · 요청 로그 per-request commit (ADR-010)
 *      · server-b 호출 (Circuit Breaker, ADR-001)
 *
 * MySQL-A (`server_a`) 와 Redis(읽기 전용) 를 사용한다. 재고는 절대 다루지 않는다 — 재고 권위는 server-c.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () =>
        buildMysqlOptions({
          database: process.env.DB_NAME_A ?? 'server_a',
          port: Number(process.env.DB_PORT_A ?? 3306),
          // ADR-N05: glob 금지 — 모노레포에서 다른 앱 엔티티를 빨아들인다.
          entities: [],
          // `[0-9]*` — data-source.js 를 배제한다 (걸리면 TypeORM 디렉터리 로더가 무한 재귀).
          migrations: [`${__dirname}/../../../migrations/server-a/[0-9]*.js`],
        }),
    }),
    TerminusModule,
  ],
  controllers: [HealthController],
})
export class ServerAModule {}
