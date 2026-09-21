import { Counter, register } from '@prometheus-io/client';

/**
 * 이름당 카운터 하나를 보장한다 (Micrometer 의 `Counter.builder(...).register(registry)` 와 같은 의미).
 *
 * ⚠️ `new Counter(...)` 를 클래스 **인스턴스 필드**로 두면 안 된다. 같은 이름이 두 번 등록되면
 *    `@prometheus-io/client` 가 `A metric with the name ... has already been registered` 로 던진다.
 *    프로바이더가 두 번 생성되는 상황(테스트, 복수 모듈 컨텍스트, hot reload)에서 부팅이 깨진다.
 */
export function counter(name: string, help: string): Counter {
  const existing = register.getSingleMetric(name);
  if (existing !== undefined) {
    return existing as Counter;
  }
  return new Counter({ name, help });
}
