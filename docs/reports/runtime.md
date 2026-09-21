# Node 런타임 제약

## 📚 문서 목록

- [Kafka](kafka.md)
- [동시성 제어](concurrency.md)
- [분산 정합성](consistency.md)
- [캐시 전략](cache.md)
- **Node 런타임 제약** ← 현재 문서

[← README](../../README.md)

---

## 한 줄 요약

JVM 은 요청마다 스레드를 줬지만 Node 는 **하나의 이벤트 루프**를 HTTP·consumer·스케줄러가 공유한다.
이 차이 때문에 사이징을 재측정해야 하고, **부팅을 막는 `await` 하나가 서비스 전체를 못 뜨게** 했다.

---

## 1. 무엇이 달라지나

| | JVM (원본) | Node |
|---|---|---|
| 동시 요청 | 가상 스레드 (요청당 1개) | 단일 이벤트 루프 |
| 블로킹 코드 | 그 스레드만 멈춤 | **전체가 멈춤** |
| 백그라운드 작업 | 별도 스레드 풀 | 같은 루프 |

server-b·c 는 HTTP 서버이면서 동시에 Kafka consumer 이고 스케줄러다. 셋이 한 루프를 쓴다.
→ **이벤트 루프를 막는 코드는 곧 API 지연**이다.

따라서 다음을 금지한다.

- 긴 동기 루프, 동기 대용량 JSON 직렬화, 동기 `crypto`
- 주기 작업의 cycle 이 겹쳐 도는 것 (각 스케줄러에 `running` 가드를 둔다)

수평 확장은 `cluster` 워커가 아니라 **컨테이너 복제**로 한다.
1 vCPU 에 워커를 늘리면 컨텍스트 스위칭만 늘어난다.

---

## 2. 사고 — 부팅을 막는 `await`

### 증상

Kafka 브로커가 없으면 **애플리케이션이 아예 뜨지 않았다.**
server-c 는 API 서버이기도 해서, 쿠폰 사용·조회처럼 Kafka 와 무관한 기능까지 함께 죽었다.

원본 Spring 은 그렇지 않다. Kafka 가 죽어도 HTTP 는 계속 서비스되고 발급 처리만 멈춘다.

### 원인은 한 곳이 아니라 세 곳이었다

Spring 은 세 가지가 각각 다른 메커니즘으로 비차단이다.

| 구성요소 | Spring | 최초 구현 |
|---|---|---|
| admin (토픽 생성) | `fail-fast: false` | 실패 시 **부팅 실패** |
| producer | `KafkaTemplate` 은 lazy | `await connect()` 가 **부팅을 막음** |
| consumer | 리스너 컨테이너가 별도 스레드에서 재시도 | `await connect()` 가 **부팅을 막음** |

admin 만 고치고 "이제 뜬다"고 판단했는데, 실제로 브로커를 끊고 띄워보니 여전히 안 떴다.
**셋 다** 비차단으로 바꿔야 했다.

### 확인 — 장애를 주입해서

`KAFKA_BOOTSTRAP` 을 없는 포트로 돌려 기동:

| 단계 | `/actuator/health` |
|---|---|
| 수정 전 | 연결 거부 (앱이 뜨지 않음) |
| admin 만 해제 | 연결 거부 |
| 세 곳 모두 비차단 | **200 `{"status":"UP"}`** — 쿠폰 사용·조회 정상 |

> "의존 컴포넌트가 없어도 뜬다"는 주장은 **실제로 끊어 보기 전까지는 추측**이다.

---

## 3. 스케줄러 첫 실행도 부팅을 막는다

Nest 는 `onApplicationBootstrap` 훅을 **await 한 뒤에** 포트를 연다.
Spring 의 `@Scheduled(fixedDelay)` 첫 실행은 별도 스케줄러 스레드라 기동을 막지 않는다.

`@Interval` 은 첫 실행이 주기 경과 후라 기동 직후 1회를 따로 넣어야 하는데,
이때 `await` 하면 그만큼 포트가 안 열린다.

> 보완 스케줄러의 첫 cycle 이 stale 50건 × 외부 호출 1.5초라면 **최대 75초 동안 포트가 닫혀 있다.**
> health probe 가 실패하고 배포가 롤백된다.

```ts
// ✅ 실행은 하되 기다리지 않는다
onApplicationBootstrap(): void {
  void this.run();
}
```

보완 스케줄러 / Outbox poller / 이벤트 캐시 갱신 **세 곳 모두** 이 방식이다.

---

## 4. 기동 실패는 재시도해야 한다

비차단으로 바꾸자 토픽 생성과 consumer 구독 사이의 레이스가 드러났다.
당시 코드는 기동 실패 시 로그만 남기고 끝냈고, 결과는
**"앱은 떠 있는데 메시지를 영원히 소비하지 않는"** 상태였다.

비차단으로 만드는 것과 실패를 무시하는 것은 다르다. 지수 backoff(1초 → 30초) 재시도 루프를 넣었다.

**확인** — 토픽이 없는 상태에서 기동: 1회 실패 후 1초 뒤 재시도로 연결, HTTP 는 1.1초 만에 응답.

---

## 5. 그 밖의 런타임 차이

### timeout 의 의미가 다르다

| | Java | Node |
|---|---|---|
| Kafka 발행 | `future.get(ms)` — 호출 대기 하드 바운드 | `send({timeout})` 은 **브로커 ack 대기값**. 로컬 재시도를 못 끊음 |
| HTTP 클라이언트 | connect / read timeout 분리 | axios 는 `timeout` 하나 (연결 타임아웃 개념 없음) |
| DB 커넥션 풀 | HikariCP `connection-timeout` = 풀 대기 상한 | mysql2 에 **대응 개념 없음** (`waitForConnections` / `queueLimit` 뿐) |

Kafka 발행은 `Promise.race` 래퍼로 하드 바운드를 복원했다.
나머지 둘은 미이관으로 기록하고 부하 검증 단계에서 재검토한다.

### 예외 클래스 동일성을 믿을 수 없다

`instanceof AxiosError` 가 실패했다. `@nestjs/axios` 를 거치면 에러가 다른 axios 인스턴스에서
생성될 수 있어 클래스 비교가 깨진다. 그 결과 404("아직 처리 전"이라는 **정상 상태**)가
전부 "조회 실패"로 분류되어 보완 스케줄러가 재발행 단계로 넘어가지 못했다 — 30초 SLA 가 100% 깨진다.

→ 상태코드를 **구조적으로** 읽는다.

```ts
function httpStatusOf(e: unknown): number | undefined {
  return (e as { response?: { status?: number } } | null | undefined)?.response?.status;
}
```

### 메트릭은 이름당 하나여야 한다

Prometheus 카운터를 클래스 인스턴스 필드로 두면 프로바이더가 두 번 생성될 때
`A metric with the name ... has already been registered` 로 터진다.
Micrometer 의 레지스트리 의미와 맞게 모듈 레벨 + getOrCreate 로 둔다.

---

## 6. 사이징은 다시 측정해야 한다

원본의 인스턴스당 977 req/s 는 **가상 스레드 기준**이다. 다음 이유로 그대로 인용할 수 없다.

- 동시성 모델이 다르다 (스레드 ↔ 이벤트 루프)
- 백그라운드 작업이 API 와 CPU 를 직접 경합한다
- 커넥션 풀·타임아웃 계열 설정 중 일부가 미이관 상태다

목표 부하(1,000 TPS)에 대한 검증은 k6 로 별도 수행한다.

---

## 7. 정리

| 교훈 | 내용 |
|---|---|
| 루프는 하나다 | 블로킹 코드 = API 지연. 주기 작업에 겹침 가드 필수 |
| 부팅을 막지 마라 | 의존 컴포넌트 연결은 전부 비차단. `onApplicationBootstrap` 도 await 금지 |
| 비차단 ≠ 무시 | 실패하면 백그라운드에서 재시도해야 한다 |
| 같은 이름, 다른 의미 | timeout·auto-commit 등은 이름만 보고 옮기면 걸린다 |
| 클래스 비교를 믿지 마라 | 라이브러리 경계를 넘으면 `instanceof` 가 깨진다 |
