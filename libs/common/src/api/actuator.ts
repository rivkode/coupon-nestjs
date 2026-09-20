import type { HealthCheckResult } from '@nestjs/terminus';

export interface ActuatorHealth {
  status: 'UP' | 'DOWN';
}

/**
 * Terminus 결과를 Spring Actuator 의 `/actuator/health` 응답 형태로 바꾼다 (spec-parity §10).
 *
 * Terminus: `{ status: 'ok' | 'error', info, error, details }`
 * 원본:     `{ status: 'UP' | 'DOWN' }` — **그게 전부다**.
 *
 * ⚠️ `components` 를 넣지 않는다. 원본 yml 은 `show-details: when-authorized` 인데
 *    세 서버 모두 spring-security 에 의존하지 않아(build.gradle.kts 확인) 인증 주체가 없고,
 *    따라서 details 가 절대 노출되지 않는다. 지표 이름을 덧붙이면 원본에 없는 필드가 생긴다.
 *
 * `load-test/run-integrated.sh` 는 `curl -sf` 로 상태코드만 보지만,
 * README / k6 주석이 "UP" 을 기대하므로 문자열까지 맞춘다.
 *
 * ⚠️ 실패 시에는 Terminus 가 `ServiceUnavailableException` 을 던져 이 함수를 거치지 않는다.
 *    503 상태코드는 유지되고 본문만 Terminus 형태로 나간다 (ADR-N06 의 HttpException 통과).
 */
export function toActuatorHealth(result: HealthCheckResult): ActuatorHealth {
  return { status: result.status === 'ok' ? 'UP' : 'DOWN' };
}
