# 부하 테스트

k6 시나리오와 통합 실행기. 결과 해석은 [`docs/reports/load-test.md`](../docs/reports/load-test.md) 참조.

## 사전 준비

```bash
brew install k6
docker compose up -d
npm run build
npm run start:a & npm run start:b & npm run start:c &
```

## 실행

```bash
SCENARIO=smoke TOTAL_INVENTORY=100 ./run-load.sh   # 스모크 (1회 호출)
TOTAL_INVENTORY=100 ./run-load.sh                  # 1,000 TPS × 60초
```

`run-load.sh` 가 하는 일:

1. 세 서버 health 확인
2. 마스터 데이터 시드 (재고 reset, 이전 run 흔적 삭제)
3. **Redis FLUSHDB** — 매진 캐시가 남아 있으면 A 가 전부 단락해 부하가 의미를 잃는다
4. k6 실행 (`results/` 에 요약 저장)
5. **A 접수 vs C 처리 대조** — 유실이나 초과 발급이 있으면 실패로 종료

## 시나리오

| 파일 | 용도 |
|---|---|
| `scenarios/smoke.js` | 1회 호출로 환경 점검 |
| `scenarios/issue-1k-tps.js` | 1,000 TPS × 60초 (본 측정) |
| `scenarios/server-b-direct.js` | A·CB 를 배제한 server-b 단독 상한 |

## 재고 설정이 결과를 바꾼다

`TOTAL_INVENTORY` 는 단순한 파라미터가 아니라 **측정하는 대상을 바꾼다.**

| 재고 | 무엇을 보는가 |
|---|---|
| 100 (요구사항 기준) | 설계 시나리오. 대부분의 요청이 A 에서 매진 단락된다 |
| 10,000 | 모든 요청이 전 구간을 통과한다. server-c 의 소비 속도가 상한으로 드러난다 |

두 경우의 실제 측정값과 해석은 [부하 검증 보고서](../docs/reports/load-test.md)에 있다.
