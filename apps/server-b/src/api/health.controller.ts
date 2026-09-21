import { toActuatorHealth, type ActuatorHealth } from '@app/common';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { HealthCheckService } from '@nestjs/terminus';
import type { Response } from 'express';

/**
 * Spring Actuator 의 `/actuator/health` 대응 (api-contract §10).
 *
 * server-b 는 DB 가 없다 (ADR-006 — Redis only). 현재는 liveness 만 보고,
 * Redis store 가 들어오면 지표를 추가한다.
 *
 * ⚠️ `@HealthCheck()` 미사용 이유는 server-a/c 의 같은 파일 주석 참고 (ADR-N06).
 */
@Controller('actuator')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get('health')
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ActuatorHealth> {
    try {
      return toActuatorHealth(await this.health.check([]));
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'DOWN' };
    }
  }
}
