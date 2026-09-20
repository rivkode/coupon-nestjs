---
name: nest-ddd-layering
description: 본 프로젝트의 NestJS 레이어드 + 경량 DDD 구조 규칙. api/application/domain/infrastructure 4계층의 의존 방향, domain 의 무의존 원칙, 리포지토리를 abstract class 로 선언해 DI 토큰으로 쓰는 방법, 쓰기 애그리거트만 도메인 모델로 분리하고 읽기 경로는 ORM 엔티티를 직접 쓰는 기준, 모노레포 apps/libs 배치, 파일·클래스 네이밍을 다룬다. 새 파일/클래스/모듈을 만들기 전, 어느 계층에 둘지 고민될 때, 리팩토링 시 PROACTIVELY 사용한다. 헥사고날은 도입하지 않는다.
---

# NestJS DDD Layering

Java 원본의 `api / application / domain / infrastructure` 4계층을 그대로 옮긴다.
**헥사고날(포트&어댑터)은 도입하지 않는다** — 원본 CLAUDE.md §10 의 명시적 결정이다.

---

## 1. 의존 방향 — 이것만 지키면 된다

```
        api  ──────▶  application  ──────▶  domain
                            │                  ▲
                            └──────────────────┘
                     infrastructure ───────────┘
                     (domain 의 abstract class 를 구현)
```

| 계층 | import 해도 되는 것 | 절대 금지 |
|---|---|---|
| `api/` | `@nestjs/*`, `class-validator`, `application/`, `domain/`(타입만) | `typeorm`, `ioredis`, `kafkajs`, `infrastructure/` |
| `application/` | `@nestjs/common`, `typeorm`(DataSource/EntityManager 타입만), `domain/`, `libs/common` | `api/`, ORM 엔티티를 **쓰기** 경로에서 사용 |
| `domain/` | **아무것도** (순수 TS + `libs/common` 타입만) | `@nestjs/*`, `typeorm`, `ioredis`, `kafkajs` 전부 |
| `infrastructure/` | 전부 | `api/` |

`domain/` 파일 상단에 `import` 가 `libs/common` 외에 하나라도 있으면 설계가 샌 것이다.

**CI 강제** (도입 시): `dependency-cruiser` 로 위 표를 룰로 박는다.

---

## 2. 리포지토리 — abstract class 로 선언

TypeScript `interface` 는 런타임에 사라져 DI 토큰이 될 수 없다. **abstract class** 를 쓴다.

```ts
// domain/user-coupon.repository.ts  ← 순수. typeorm import 없음.
import type { EntityManager } from 'typeorm'; // ⚠️ 아래 주석 참고
import { UserCoupon } from './user-coupon';

export abstract class UserCouponRepository {
  abstract findByCode(em: TxContext, code: string): Promise<UserCoupon | null>;
  abstract existsByUserIdAndCouponTypeId(em: TxContext, userId: bigint, couponTypeId: bigint): Promise<boolean>;
  abstract save(em: TxContext, coupon: UserCoupon): Promise<UserCoupon>;
}
```

ADR-N01 에 따라 트랜잭션 컨텍스트를 첫 인자로 받는다.
`domain/` 이 `typeorm` 을 알면 안 되므로 **`TxContext` 라는 도메인 측 타입 별칭**을 두고
`infrastructure` 에서 `EntityManager` 로 좁힌다:

```ts
// domain/tx-context.ts
export type TxContext = unknown & { readonly __tx?: never };
```

구현:

```ts
// infrastructure/persistence/typeorm-user-coupon.repository.ts
@Injectable()
export class TypeOrmUserCouponRepository extends UserCouponRepository {
  async findByCode(em: TxContext, code: string) {
    const row = await (em as EntityManager).findOne(UserCouponOrmEntity, { where: { code } });
    return row ? UserCouponMapper.toDomain(row) : null;
  }
}
```

모듈 등록:

```ts
providers: [{ provide: UserCouponRepository, useClass: TypeOrmUserCouponRepository }]
```

서비스는 추상 타입으로 주입받는다 — `constructor(private readonly repo: UserCouponRepository) {}`

---

## 3. 모델 분리 수준 — 쓰기 애그리거트만

| 대상 | 도메인 모델 + 매퍼 | 이유 |
|---|---|---|
| `UserCoupon` | ✅ | `markUsed()` 등 상태 전이 규칙 보유 |
| `CouponTypeInventory` | ✅ | `decrement()` — 재고 규칙이 동시성의 핵심 |
| `IssueRequest` | ✅ | 원본 server-a 가 이미 분리 |
| `PendingIssue` | ✅ | Redis Hash ↔ 도메인 |
| `Event` | ✅(얇게) | `isActive(now)` 보유 |
| 내 쿠폰 목록 조회 | ❌ ORM 엔티티 직접 | 읽기 전용. 매퍼는 보일러플레이트일 뿐 |
| 이벤트 단건 조회 | ❌ ORM 엔티티 직접 | 같음 |
| `OutboxEvent` | ❌ ORM 엔티티 직접 | 도메인 규칙 없는 전송 큐 |

판단 기준: **그 타입에 if 문이 들어가는 비즈니스 규칙이 있는가?** 있으면 도메인 모델, 없으면 ORM 엔티티.

도메인 모델은 Java 원본과 같은 형태를 유지한다 — private 생성자 + 정적 팩토리:

```ts
export class IssueRequest {
  private constructor(/* ... */) {}
  static of(userId: bigint, eventId: bigint, couponTypeId: bigint,
            status: IssueRequestStatus, now: Date): IssueRequest { /* ... */ }
  static reconstitute(/* 모든 필드 */): IssueRequest { /* ... */ }
}
```
- `of()` = 새로 만들 때 (id 없음, requestId 생성)
- `reconstitute()` = DB 에서 복원할 때 (매퍼가 호출)

---

## 4. 모노레포 배치

```
apps/server-{a,b,c}/src/
├── main.ts                  # bootstrap, 전역 파이프/필터, enableShutdownHooks()
├── server-{a,b,c}.module.ts # 루트 모듈
├── api/
│   ├── *.controller.ts
│   ├── dto/*.dto.ts
│   └── filters/global-exception.filter.ts
├── application/
│   ├── *.service.ts         # 유스케이스 + 트랜잭션 경계
│   ├── *.command.ts         # 입력 (api DTO ≠ command)
│   └── *.outcome.ts         # 출력 (도메인 ≠ 응답 DTO)
├── domain/
│   ├── <aggregate>.ts
│   ├── <aggregate>.repository.ts
│   ├── *.enum.ts
│   └── exception/*.exception.ts
└── infrastructure/
    ├── persistence/  *.orm-entity.ts, *.mapper.ts, typeorm-*.repository.ts
    ├── redis/        redis-*.store.ts, redis-keys.ts
    ├── kafka/        *-publisher.ts, *-consumer.ts, kafka.module.ts
    ├── client/       *-client.ts (HTTP)
    └── config/       *.config.ts

libs/common/src/coupon/   # = Gradle :common. 세 앱이 공유하는 payload/enum/코드 생성
```

`tsconfig.json` 의 `paths` 로 `@app/common` 별칭을 만든다 (Nest CLI 가 생성).

---

## 5. 네이밍

| 종류 | 파일 | 클래스 |
|---|---|---|
| 도메인 모델 | `user-coupon.ts` | `UserCoupon` |
| 리포지토리 추상 | `user-coupon.repository.ts` | `UserCouponRepository` (abstract) |
| 리포지토리 구현 | `typeorm-user-coupon.repository.ts` | `TypeOrmUserCouponRepository` |
| ORM 엔티티 | `user-coupon.orm-entity.ts` | `UserCouponOrmEntity` |
| 매퍼 | `user-coupon.mapper.ts` | `UserCouponMapper` (static only) |
| 애플리케이션 서비스 | `redeem-coupon.service.ts` | `RedeemCouponService` |
| 커맨드 / 결과 | `redeem.command.ts` | `RedeemCommand` / `RedeemResult` |
| 컨트롤러 | `redeem-coupon.controller.ts` | `RedeemCouponController` |
| 요청 DTO | `issue-coupon-request.dto.ts` | `IssueCouponRequestDto` |

Java 의 `XxxJpaEntity` → TS 의 `XxxOrmEntity` 로 1:1 대응시킨다 (대조가 쉬워진다).

---

## 6. 흔한 실수

| 증상 | 문제 | 고치는 법 |
|---|---|---|
| `domain/` 에서 `@Entity()` 를 붙임 | 도메인이 ORM 에 오염 | ORM 엔티티는 `infrastructure/persistence/` |
| 컨트롤러가 `Repository` 를 직접 주입 | application 계층 건너뜀 | 서비스를 경유 |
| 서비스가 `Res` / `Req` 를 인자로 받음 | HTTP 가 application 으로 샘 | 컨트롤러에서 Command 로 변환 |
| `interface XxxRepository` + `Symbol` 토큰 | 장황하고 타입 안전성 낮음 | abstract class |
| 읽기 조회마다 매퍼 작성 | 보일러플레이트 | §3 — 읽기는 ORM 엔티티 직접 |
| 트랜잭션을 리포지토리 안에서 염 | 경계가 흩어짐 | 경계는 application 에만 (ADR-N01) |
| 한 서비스가 두 앱을 import | 서비스 경계 위반 | `libs/common` 을 통해서만 공유 |
