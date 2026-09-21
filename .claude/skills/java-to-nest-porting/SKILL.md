---
name: java-to-nest-porting
description: Java/Spring Boot 원본 파일을 NestJS/TypeScript 로 옮기는 절차와 관용구 치환표. 원본 읽기 → 계층 판정 → 매핑표 적용 → 스펙 대조 → 테스트 순서를 강제하고, @RestController/@Service/@Transactional/@Scheduled/@KafkaListener/Resilience4j/Lombok/Optional/record/Instant 같은 Spring·Java 관용구의 Nest·TS 대응을 제공한다. 원본 파일을 옮기는 모든 작업에서 파일마다 PROACTIVELY 사용한다. "포팅", "옮겨", "마이그레이션", "변환" 이 언급되면 먼저 이 스킬을 거친다.
---

# Java → NestJS 포팅 절차

원본: `~/dev/project/java/promotion-event`
**요약본을 믿지 말고 원본 파일을 직접 읽는다.** 주석에 담긴 트레이드오프 설명이 설계의 절반이다.

---

## 1. 파일 하나를 옮기는 절차

```
1) 원본 읽기        원본 .java 전체 + 그 클래스가 의존하는 인터페이스/상위 타입
                    + 같은 이름의 테스트 파일 (XxxTest.java, XxxIT.java)
2) 계층 판정        api / application / domain / infrastructure  → nest-ddd-layering 스킬
3) 계약 확인        API·스키마·Redis 키·Kafka payload 를 건드리는가 → api-contract 스킬
4) 치환            아래 §2~§4 표를 적용
5) 주석 이관        ⚠️ 비즈니스 결정/트레이드오프 주석은 반드시 함께 옮긴다.
                    ADR 참조(예: "ADR-008") 는 문구 그대로 유지
6) 테스트 이관      원본 테스트의 케이스 이름과 시나리오를 그대로 Jest 로
7) 대조            spec-auditor 에이전트로 원본 대비 동작 차이 확인
```

**"이 부분은 TS 답게 개선하자" 는 유혹을 계층 구조와 계약에는 적용하지 않는다.**
관용구(§2)만 바꾸고, 흐름·순서·분기·로그 메시지는 원본을 따른다.

---

## 2. Spring → NestJS 치환표

| Spring | NestJS |
|---|---|
| `@RestController` + `@RequestMapping` | `@Controller('api/v1/...')` |
| `@PostMapping` / `@GetMapping` | `@Post()` / `@Get()` |
| `@RequestBody` | `@Body()` |
| `@PathVariable` | `@Param('name')` |
| `@RequestHeader("X-User-Id")` | `@Headers('x-user-id')` 또는 전용 `@UserId()` 데코레이터 |
| `@Valid` + Bean Validation | 전역 `ValidationPipe({ whitelist: true, transform: true })` + `class-validator` |
| `@RestControllerAdvice` + `@ExceptionHandler` | `@Catch()` 구현체 + `app.useGlobalFilters()` |
| `@Service` / `@Component` | `@Injectable()` |
| `@RequiredArgsConstructor` (Lombok) | 생성자 파라미터 프로퍼티 `constructor(private readonly x: X) {}` |
| `@Transactional` | `dataSource.transaction(async (em) => ...)` — **ADR-N01** |
| `@Scheduled(fixedDelayString=...)` | `@nestjs/schedule` 의 `@Interval(ms)` |
| `@KafkaListener` | kafkajs `consumer.run({ eachBatch, autoCommit:false })` — **ADR-N02** |
| `KafkaTemplate.send()` | kafkajs `producer.send()` |
| `StringRedisTemplate` | `ioredis` 인스턴스를 `@Injectable()` store 로 래핑 |
| `RestClient` / `WebClient` | `@nestjs/axios` `HttpService` (+ `firstValueFrom`) |
| Resilience4j `@CircuitBreaker` + `@Retry` | `cockatiel` — `circuitBreakerPolicy` + `retryPolicy` + `timeoutPolicy` 를 `wrap()` |
| `@Value("${app.x:default}")` | `ConfigService.get('APP_X', default)` |
| `@ConfigurationProperties` | `registerAs()` 네임스페이스 config + 주입 |
| Actuator `/actuator/health` | `@nestjs/terminus` 로 **같은 경로**에 노출 |
| Micrometer counter | `prom-client` `Counter` |
| `ApplicationRunner` / `@PostConstruct` | `OnModuleInit` |
| graceful shutdown | `app.enableShutdownHooks()` + `OnApplicationShutdown` |

---

## 3. Java → TypeScript 치환표

| Java | TypeScript |
|---|---|
| `record Foo(...)` | `class Foo { constructor(readonly a: A, ...) {} }` 또는 `interface` + 팩토리 |
| `Optional<T>` | `T \| null` (undefined 와 섞지 말 것) |
| `enum Status { A, B }` | `type Status = 'A' \| 'B'` + `const STATUSES = [...] as const` |
| `switch (s) { case A -> ... }` | `switch (s) { case 'A': return ...; }` — **default 에서 throw** 해 누락을 잡는다 |
| `Instant` / `LocalDateTime` | `Date` (DB 는 UTC, `timezone:'Z'`) |
| `Instant.now().toEpochMilli()` | `Date.now()` |
| `UUID.randomUUID().toString()` | `crypto.randomUUID()` (node:crypto) |
| `Objects.requireNonNull(x, "x")` | `if (x == null) throw new Error('x')` |
| `long` / `Long` (BIGINT) | **`string` 으로 통일** — typeorm-patterns §6.1 |
| `List.of()` | `[]` (readonly 필요 시 `as const`) |
| `Map.of(...)` | 객체 리터럴 또는 `new Map()` |
| checked exception | 없음 — 도메인 예외 클래스 + ExceptionFilter 매핑 |
| `log.info("x {}", v)` (SLF4J) | `this.logger.log(\`x ${v}\`)` — 템플릿 리터럴 |
| `private static final Logger log` | `private readonly logger = new Logger(Xxx.name)` |
| `@Version` (JPA) | ⚠️ 조건부 UPDATE — **ADR-N03** |
| Testcontainers | `testcontainers` (npm) — `@testcontainers/mysql`, `...redis`, `...kafka` |
| JUnit `@Test` / `@DisplayName` | Jest `it('원본 DisplayName 그대로', ...)` |

---

## 4. 서버별 포팅 주의점

### server-a
- `IssueRequestService` 는 **`@Transactional` 이 없다** — 원본 주석이 이유를 설명한다. 트랜잭션을 만들지 말 것.
- SOLD_OUT 단락이 **B 호출보다 먼저** 온다 (ADR-011). 순서를 바꾸면 ADR 위반.
- CB OPEN 시 503 + `Retry-After: 5`, 본문은 `success: true` — 이상해 보여도 원본대로 (api-contract §4).
- `application-*.yml` 의 CB/Retry 수치(`slow-call-duration-threshold: 800ms`, `max-attempts: 2` 등)는
  **부하 테스트로 얻은 값**이다. 기본값으로 갈아엎지 말고 그대로 옮긴다.

### server-b
- DB 가 없다. TypeORM 모듈을 붙이지 않는다.
- `savePendingIfAbsent` 의 `HSETNX → HSET → ZADD` 순서와 "원자적이지 않아도 되는 이유" 주석을 그대로.
- 스케줄러(ADR-008)의 3분기 — C 에 있음 / 없고 attempts<3 / attempts≥3 — 순서와 cap 증가 시점(publish **직전**)이 SLA 근거다.
- publish 실패는 **삼킨다** (항상 ACCEPTED 응답). 예외를 올리지 말 것.

### server-c
- `CouponIssueProcessor` 의 5단계 순서(중복 체크 → 이벤트 유효성 → 비관락 차감 → user_coupon INSERT → outbox INSERT)를 바꾸지 않는다.
- SOLD_OUT / FAILED 도 `user_coupon` row 를 남긴다 (placeholder code). 폴링 응답용.
- `OutboxPoller` 에 트랜잭션을 걸지 않는다 — 원본 주석이 이유를 길게 설명한다. 3단계(짧은 read → 트랜잭션 밖 publish → 성공분 bulk update)를 유지.
- `EventCacheRefresher` 는 refresh(1분) < TTL(5분) 이라 stampede 가 원천 차단된다는 것이 설계 의도.

---

## 5. 파일 매핑 (원본 → 대상)

| 원본 | 대상 |
|---|---|
| `common/.../coupon/*.java` | `libs/common/src/coupon/*.ts` |
| `server-x/.../api/XxxController.java` | `apps/server-x/src/api/xxx.controller.ts` |
| `server-x/.../api/dto/Xxx.java` | `apps/server-x/src/api/dto/xxx.dto.ts` |
| `server-x/.../api/exception/GlobalExceptionHandler.java` | `apps/server-x/src/api/filters/global-exception.filter.ts` |
| `server-x/.../application/XxxService.java` | `apps/server-x/src/application/xxx.service.ts` |
| `server-x/.../domain/Xxx.java` | `apps/server-x/src/domain/xxx.ts` |
| `server-x/.../domain/XxxRepository.java` | `apps/server-x/src/domain/xxx.repository.ts` (abstract class) |
| `server-x/.../infrastructure/persistence/XxxJpaEntity.java` | `.../infrastructure/persistence/xxx.orm-entity.ts` |
| `server-x/.../infrastructure/persistence/XxxRepositoryImpl.java` | `.../persistence/typeorm-xxx.repository.ts` |
| `server-x/.../infrastructure/redis/*.java` | `.../infrastructure/redis/*.ts` |
| `server-x/.../infrastructure/kafka/*.java` | `.../infrastructure/kafka/*.ts` |
| `server-x/src/main/resources/application.yml` | `.env` + `.../infrastructure/config/*.config.ts` |
| `server-x/src/main/resources/db/migration/V*.sql` | `migrations/server-x/*.ts` (SQL 원문 유지) |
| `server-x/src/test/**/XxxTest.java` | `apps/server-x/src/**/xxx.spec.ts` |
| `server-x/src/test/**/XxxIT.java` | `test/server-x/xxx.e2e-spec.ts` |

---

## 6. 포팅 완료 판정

원본 파일 하나를 옮겼으면 아래를 전부 답할 수 있어야 한다.

- [ ] 원본의 **모든 분기**가 대상에 있는가 (early return 포함)
- [ ] 원본의 **로그 지점과 내용**이 같은가
- [ ] 원본의 **예외 종류와 발생 조건**이 같은가 → 같은 HTTP 코드로 매핑되는가
- [ ] 원본의 **주석에 적힌 결정 근거**가 옮겨졌는가
- [ ] 원본 yml 의 **튜닝 수치**가 그대로인가 (임의 기본값으로 대체하지 않았는가)
- [ ] 원본 테스트 케이스가 전부 대응되는가
- [ ] `api-contract` 체크리스트를 통과하는가
