/**
 * 트랜잭션 컨텍스트의 도메인 측 표현 (ADR-N01).
 *
 * 실제 값은 TypeORM 의 `EntityManager` 지만, `domain/` 은 typeorm 을 import 할 수 없으므로
 * (nest-ddd-layering §1) 여기서 **능력(capability)** 으로만 선언하고
 * `infrastructure/` 에서 `EntityManager` 로 좁힌다.
 *
 * `query` 하나만 요구하는 이유:
 *  - `EntityManager` 가 구조적으로 만족한다 (별도 어댑터가 필요 없다)
 *  - "SQL 을 실행할 수 있는 무언가" 는 트랜잭션 컨텍스트의 정직한 최소 정의다
 *  - 빈 브랜드 타입(`{ readonly [sym]?: never }`)은 TS 의 weak type 검사에 걸려
 *    `EntityManager` 를 넘길 때 TS2559 가 난다
 *
 * 사용 규칙:
 *  - 쓰기 경로: `dataSource.transaction(async (em) => repo.save(em, ...))`
 *  - 읽기 경로: 트랜잭션이 필요 없으면 `dataSource.manager` 를 그대로 넘긴다
 *  - ⚠️ 콜백 밖의 매니저를 콜백 안에서 쓰면 **다른 커넥션**이라 락이 걸리지 않는다
 *    (typeorm-patterns §1)
 */
export interface TxContext {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}
