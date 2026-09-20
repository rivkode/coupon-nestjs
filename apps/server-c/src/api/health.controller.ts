import { toActuatorHealth, type ActuatorHealth } from '@app/common';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import type { Response } from 'express';

/**
 * Spring Actuator 의 `/actuator/health` 대응 (spec-parity §10).
 * 경로와 본문(`{"status":"UP"}` / `{"status":"DOWN"}`)을 원본 그대로 유지해야
 * 원본의 load-test 스크립트가 같이 동작한다.
 *
 * ⚠️ Terminus 의 `@HealthCheck()` 데코레이터를 쓰지 않는다. 그 경우 실패가
 *    `ServiceUnavailableException` 으로 떠서 전역 필터가 봉투를 씌워 버리고,
 *    Actuator 본문 형태가 깨진다 (ADR-N06). 여기서 직접 503 + DOWN 을 쓴다.
 */
@Controller('actuator')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  @Get('health')
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ActuatorHealth> {
    try {
      const result = await this.health.check([
        () => this.db.pingCheck('mysql-c', { timeout: 1000 }),
      ]);
      return toActuatorHealth(result);
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'DOWN' };
    }
  }
}
