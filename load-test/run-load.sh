#!/usr/bin/env bash
# k6 통합 부하 시나리오 실행기.
#
# 하는 일:
#   1. 세 서버 health 확인
#   2. 마스터 데이터 시드 (재고 reset, 이전 run 흔적 삭제)
#   3. 매진 negative cache 와 Redis pending 초기화
#   4. k6 시나리오 실행
#   5. **A 가 접수한 수 vs C 가 실제 발급한 수**를 대조 (정합성 검증)
#
# 사용:
#   ./load-test/run-load.sh                          # 1,000 TPS × 60초
#   SCENARIO=smoke ./load-test/run-load.sh           # 스모크
#   TOTAL_INVENTORY=5000 DURATION=30s ./load-test/run-load.sh
set -euo pipefail

cd "$(dirname "$0")/.."

SCENARIO="${SCENARIO:-issue-1k-tps}"
TOTAL_INVENTORY="${TOTAL_INVENTORY:-10000}"
EVENT_ID="${EVENT_ID:-1}"
COUPON_TYPE_ID="${COUPON_TYPE_ID:-1}"
MYSQL_C="${MYSQL_C:-coupon-mysql-c}"
MYSQL_A="${MYSQL_A:-coupon-mysql-a}"
REDIS="${REDIS:-coupon-redis}"
RESULT_DIR="load-test/results"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1) 서버 health 확인"
for port in 8080 8081 8082; do
  if ! curl -sf "http://localhost:${port}/actuator/health" >/dev/null; then
    echo "  :${port} 응답 없음 — 세 서버를 먼저 띄우세요 (npm run start:a|b|c)" >&2
    exit 1
  fi
  echo "  :${port} UP"
done

say "2) 마스터 데이터 시드 (재고 ${TOTAL_INVENTORY})"
sed "s/\${TOTAL_INVENTORY}/${TOTAL_INVENTORY}/g" load-test/seed.sql \
  | docker exec -i "${MYSQL_C}" mysql -upromotion -ppromotion 2>/dev/null
docker exec -i "${MYSQL_A}" mysql -upromotion -ppromotion server_a \
  -e "DELETE FROM issue_request" 2>/dev/null
echo "  server_c 시드 완료, server_a 요청 로그 초기화"

say "3) Redis 초기화 (매진 캐시 + pending)"
# 매진 캐시가 남아 있으면 A 가 전부 단락해 부하가 의미를 잃는다.
docker exec "${REDIS}" redis-cli FLUSHDB >/dev/null 2>&1
echo "  FLUSHDB 완료"

say "4) k6 실행 — ${SCENARIO}"
mkdir -p "${RESULT_DIR}"
SUMMARY="${RESULT_DIR}/${SCENARIO}-${STAMP}.json"
set +e
EVENT_ID="${EVENT_ID}" COUPON_TYPE_ID="${COUPON_TYPE_ID}" \
  k6 run --summary-export "${SUMMARY}" "load-test/scenarios/${SCENARIO}.js"
K6_EXIT=$?
set -e

say "5) 정합성 대조 — 비동기 처리가 끝날 때까지 대기"
# A 접수 → Kafka → C 처리 → Outbox → B 반영까지 시간이 걸린다.
for _ in $(seq 1 30); do
  sleep 2
  PENDING=$(docker exec "${MYSQL_C}" mysql -upromotion -ppromotion -N -B server_c \
    -e "SELECT COUNT(*) FROM outbox_event WHERE status='PENDING'" 2>/dev/null || echo 0)
  [ "${PENDING}" = "0" ] && break
done

ACCEPTED=$(docker exec "${MYSQL_A}" mysql -upromotion -ppromotion -N -B server_a \
  -e "SELECT COUNT(*) FROM issue_request WHERE status='ACCEPTED'" 2>/dev/null)
SHORT_CIRCUIT=$(docker exec "${MYSQL_A}" mysql -upromotion -ppromotion -N -B server_a \
  -e "SELECT COUNT(*) FROM issue_request WHERE status='SOLD_OUT'" 2>/dev/null)
REJECTED=$(docker exec "${MYSQL_A}" mysql -upromotion -ppromotion -N -B server_a \
  -e "SELECT COUNT(*) FROM issue_request WHERE status='REJECTED'" 2>/dev/null)
ISSUED=$(docker exec "${MYSQL_C}" mysql -upromotion -ppromotion -N -B server_c \
  -e "SELECT COUNT(*) FROM user_coupon WHERE status='SUCCESS'" 2>/dev/null)
SOLD_OUT=$(docker exec "${MYSQL_C}" mysql -upromotion -ppromotion -N -B server_c \
  -e "SELECT COUNT(*) FROM user_coupon WHERE status='SOLD_OUT'" 2>/dev/null)
LEFT=$(docker exec "${MYSQL_C}" mysql -upromotion -ppromotion -N -B server_c \
  -e "SELECT available_count FROM coupon_type_inventory WHERE event_id=${EVENT_ID}" 2>/dev/null)
OUTBOX_PENDING=$(docker exec "${MYSQL_C}" mysql -upromotion -ppromotion -N -B server_c \
  -e "SELECT COUNT(*) FROM outbox_event WHERE status='PENDING'" 2>/dev/null)

printf '  %-28s %s\n' "A 접수 (ACCEPTED)"      "${ACCEPTED}"
printf '  %-28s %s\n' "A 매진 단락 (SOLD_OUT)"  "${SHORT_CIRCUIT}"
printf '  %-28s %s\n' "A 거부 (REJECTED)"       "${REJECTED}"
printf '  %-28s %s\n' "C 발급 성공"             "${ISSUED}"
printf '  %-28s %s\n' "C 매진 응답"             "${SOLD_OUT}"
printf '  %-28s %s / %s\n' "재고 잔량"          "${LEFT}" "${TOTAL_INVENTORY}"
printf '  %-28s %s\n' "미발행 outbox"           "${OUTBOX_PENDING}"

say "정합성 판정"
FAIL=0
if [ "$((ISSUED + SOLD_OUT))" -ne "${ACCEPTED}" ]; then
  echo "  ❌ A 접수(${ACCEPTED}) ≠ C 처리(${ISSUED} + ${SOLD_OUT}) — 유실 또는 미처리"
  FAIL=1
else
  echo "  ✅ A 접수 = C 처리 (유실 없음)"
fi
if [ "${ISSUED}" -gt "${TOTAL_INVENTORY}" ]; then
  echo "  ❌ 재고(${TOTAL_INVENTORY})보다 많이 발급됨 (${ISSUED}) — 락 실패"
  FAIL=1
else
  echo "  ✅ 발급 수(${ISSUED}) ≤ 재고(${TOTAL_INVENTORY}) — 초과 발급 없음"
fi
if [ "${OUTBOX_PENDING}" -ne 0 ]; then
  echo "  ⚠️  미발행 outbox ${OUTBOX_PENDING} 건 (poller 지연 또는 브로커 문제)"
fi

echo
echo "  요약: ${SUMMARY}"
exit $(( K6_EXIT != 0 ? K6_EXIT : FAIL ))
