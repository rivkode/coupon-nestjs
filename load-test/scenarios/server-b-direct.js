// server-b 단독 상한 측정. A 와 CB 를 배제하고 "접수" 경로만 본다.
// 접수 = Redis 적재(HSETNX/HSET/EXPIRE/ZADD) + Kafka publish.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.B_URL || 'http://localhost:8081';
const RATE = Number(__ENV.RATE || 1000);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    direct: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: 800,
    },
  },
};

export default function () {
  const userId = __VU * 1000000 + __ITER + 1;
  const res = http.post(
    `${BASE}/internal/v1/coupons/issue`,
    JSON.stringify({ eventId: 1, couponTypeId: 1 }),
    { headers: { 'X-User-Id': String(userId), 'Content-Type': 'application/json' } },
  );
  check(res, { 'status 200': (r) => r.status === 200 });
}
