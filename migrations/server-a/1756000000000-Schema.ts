import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 원본 `server-a/src/main/resources/db/migration/V1__schema.sql` 을 그대로 옮긴 것 (ADR-N05).
 * DDL 문자열을 수정하지 말 것 — 컬럼 타입·인덱스 이름까지 parity 대상이다.
 *
 * -- Server A — 발급 요청 로그 (per-request commit, ADR-010).
 * -- (user_id, coupon_type_id) UNIQUE 는 Server C 가 권위 (ADR-004) — 본 테이블은 audit/추적용.
 */
export class Schema1756000000000 implements MigrationInterface {
  name = 'Schema1756000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE issue_request (
          id              BIGINT       NOT NULL AUTO_INCREMENT,
          request_id      VARCHAR(36)  NOT NULL,
          user_id         BIGINT       NOT NULL,
          event_id        BIGINT       NOT NULL,
          coupon_type_id  BIGINT       NOT NULL,
          status          VARCHAR(20)  NOT NULL,
          created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          KEY idx_issue_request_user (user_id),
          KEY idx_issue_request_request_id (request_id)
      ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE issue_request`);
  }
}
