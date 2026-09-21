# 문서

[← README](../README.md)

## 설계

| 문서 | 내용 |
|---|---|
| [시스템 아키텍처](design/architecture.md) | 요구사항, 서비스 구성, 발급 흐름 |
| [ERD / 데이터 모델](design/erd.md) | MySQL 스키마, Redis 키, Kafka 토픽 |
| [API 명세](design/api-spec.md) | 공개 API 4개 + 내부 API 2개, 에러 코드 |
| [기술 결정 기록](decisions/README.md) | 설계 차원의 결정 + Node 환경에서 새로 내린 결정 |

## 기술 보고서

각 보고서는 **무엇을 만들려 했고, Node 스택에서 무엇이 달랐고, 어떻게 확인했는지** 순서로 쓴다.

| 문서 | 핵심 |
|---|---|
| [Kafka](reports/kafka.md) | kafkajs 에 없거나 기본값이 반대인 설정 — 메시지 유실·오프셋 미커밋 사고와 해결 |
| [동시성 제어](reports/concurrency.md) | 비관적 락(재고), 낙관적 락(쿠폰 사용). `@VersionColumn` 이 동작하지 않는 이유 |
| [분산 정합성](reports/consistency.md) | Outbox, UNIQUE 멱등, 보완 스케줄러의 30초 SLA |
| [캐시 전략](reports/cache.md) | Refresh-Ahead 로 TTL 만료 제거, 매진 negative cache |
| [Node 런타임 제약](reports/runtime.md) | 단일 이벤트 루프, 부팅 차단 사고, timeout 의미 차이 |
| [부하 검증](reports/load-test.md) | k6 1,000 TPS 측정. 설계 시나리오 통과, 전 구간 부하 시 server-c 가 상한 |

## 앞으로 추가될 것

- 1 vCPU 제약 하 재측정 및 인프라 사이징
