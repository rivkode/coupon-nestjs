import { Controller, Get, Header } from '@nestjs/common';
import { register } from '@prometheus-io/client';

/**
 * Spring Actuator 의 `/actuator/prometheus` 대응.
 *
 * 원본 yml: `management.endpoints.web.exposure.include: health, info, metrics, prometheus`
 *
 * ADR-008 이 `pending.scheduler.give_up` 카운터를 **30s SLA 의 관측 지표**로 명시하고 있어서,
 * 이 엔드포인트가 없으면 SLA 위반을 확인할 방법이 없다.
 *
 * ⚠️ 지표 이름은 Micrometer 의 `.` 표기가 Prometheus 로 노출될 때 `_` 가 되는 것과 맞춘다
 *    (`pending.scheduler.give_up` → `pending_scheduler_give_up`).
 */
@Controller('actuator')
export class MetricsController {
  @Get('prometheus')
  @Header('Content-Type', register.contentType)
  async metrics(): Promise<string> {
    return register.metrics();
  }
}
