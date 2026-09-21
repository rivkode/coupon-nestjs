# docs

이 리포에서 생성된 문서. **설계의 원천은 여기가 아니다** —
요구사항 · 아키텍처 · ERD · API 명세 · ADR 근거는 전부 Java 원본 리포의 `docs/` 에 있다
(`~/dev/project/java/promotion-event/docs/`). 여기서 요약본을 다시 만들지 않는다.

여기에는 **포팅 과정에서만 생기는 것**을 남긴다.

| 문서 | 내용 |
|---|---|
| [kafka-consumer-incident.md](kafka-consumer-incident.md) | Kafka consumer 메시지 유실 · 오프셋 미커밋 결함 보고서 (2단계). Spring Kafka ↔ kafkajs 기본값 차이가 원인 |

## 앞으로 들어올 것

- Node 기준 부하 테스트 결과 및 인프라 사이징 (5단계) — Java 측정치(인스턴스당 977 RPS)는
  가상 스레드 기준이라 그대로 인용할 수 없다 (CLAUDE.md §2, ADR-N04)
