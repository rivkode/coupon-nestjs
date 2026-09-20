import type { DataSourceOptions } from 'typeorm';

/**
 * MySQL 용으로 좁힌 DataSourceOptions.
 * typeorm 1.x 의 `MysqlDataSourceOptions` 는 `type: 'mysql' | 'mariadb'` 라서 Extract 조건도 둘 다 줘야 한다
 * (`{ type: 'mysql' }` 만 주면 never 가 된다).
 */
type MysqlConnectionOptions = Extract<
  DataSourceOptions,
  { type: 'mysql' | 'mariadb' }
>;

export interface MysqlOptionsInput {
  /** `server_a` | `server_c` — Database per Service (ADR-006) */
  database: string;
  /**
   * 호스트 포트. a 와 c 는 **서로 다른 MySQL 인스턴스**라 공용 `DB_PORT` 를 쓸 수 없다 (ADR-006).
   * 각 앱이 자기 환경변수(`DB_PORT_A` / `DB_PORT_C`)를 읽어 넘긴다.
   */
  port: number;
  entities: MysqlConnectionOptions['entities'];
  migrations: MysqlConnectionOptions['migrations'];
  env?: NodeJS.ProcessEnv;
}

/**
 * 원본 `application.yml` 의 datasource / jpa / flyway 블록에 대응하는 단일 정의 (ADR-N05).
 *
 * 여기서 고정되는 것들은 **바꾸면 안 되는 값**이다:
 *  - `synchronize: false` — TypeORM 이 DDL 을 만들면 제약/인덱스 이름이 달라진다
 *  - `migrationsRun: true` — Flyway 의 `flyway.enabled: true` 대응
 *  - `timezone: 'Z'` — Java 의 `hibernate.jdbc.time_zone: UTC` 대응. DATETIME(3) 해석이 어긋나는 것을 막는다
 *  - `connectionLimit` 기본 10 — HikariCP `maximum-pool-size: ${HIKARI_POOL_SIZE:10}`.
 *    · server-a 근거: 측정(`docs/reports/infra-sizing.md §7`)에서 pool 10 이 500 RPS p95=50ms 로 최저.
 *      30~50 은 USL knee 로 오히려 악화.
 *    · server-c 근거: 발급은 Kafka consumer 안의 비관적 락 트랜잭션이고 concurrency 1~2 +
 *      max-poll-records 10~50 이라 동시 connection 수요가 작다. redeem API 대비 헤드룸 포함 10.
 *    두 서버가 같은 값에 **다른 근거**를 갖는다. 한쪽을 바꿀 때 다른 쪽 근거를 함께 확인할 것.
 *    환경변수 이름은 원본과 같은 `HIKARI_POOL_SIZE` 다 — 원본 docker-compose / 부하테스트
 *    스크립트가 이 이름으로 주입하므로 바꾸면 튜닝 노브가 조용히 끊긴다.
 *
 * ⚠️ **미이관 — HikariCP `connection-timeout: 3000` 에 대응물이 없다.**
 *    원본의 이 값은 "풀에서 커넥션을 받아오는 최대 대기시간"(checkout timeout) 이고,
 *    초과하면 예외를 던져 요청이 3초 만에 실패한다. mysql2 풀에는 이 개념이 아예 없다
 *    (옵션은 `waitForConnections` / `queueLimit` / `idleTimeout` 뿐 — 소스 확인함).
 *    아래 `connectTimeout` 은 **TCP 최초 연결 timeout** 으로 의미가 다르므로 대응물이 아니다.
 *    결과: 풀이 포화되면 원본은 3초 뒤 실패하지만 우리는 큐에서 계속 대기한다.
 *    사이징 단계에서 `queueLimit` 으로 fail-fast 를 넣을지 재검토할 것.
 *    `validation-timeout: 1000` 도 동일하게 미이관이다.
 */
export function buildMysqlOptions(
  input: MysqlOptionsInput,
): MysqlConnectionOptions {
  const env = input.env ?? process.env;
  return {
    type: 'mysql',
    host: env.DB_HOST ?? 'localhost',
    port: input.port,
    username: env.DB_USER ?? 'promotion',
    password: env.DB_PASSWORD ?? 'promotion',
    database: input.database,
    entities: input.entities,
    migrations: input.migrations,
    migrationsRun: true,
    synchronize: false,
    timezone: 'Z',
    charset: 'utf8mb4',
    extra: {
      connectionLimit: Number(env.HIKARI_POOL_SIZE ?? 10),
      // TCP 최초 연결 timeout. HikariCP 의 connection-timeout(checkout) 대응물이 아니다 — 위 주석 참고.
      connectTimeout: Number(env.DB_CONNECT_TIMEOUT_MS ?? 3000),
      // 풀 포화 시 거부하지 않고 대기한다 (mysql2 기본값). checkout timeout 부재의 결과이므로 명시해 둔다.
      waitForConnections: true,
      // BIGINT 를 JS number 로 자동 변환하지 않는다 — mysql2 기본값 유지.
      // 값은 string 으로 들어오며 매퍼가 Number() 로 정규화한다 (typeorm-patterns §6.1).
      supportBigNumbers: true,
      bigNumberStrings: true,
    },
    logging: ['error', 'warn'],
  };
}
