import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 원본 `server-c/src/main/resources/db/migration/V2__add_event_status.sql` 을 그대로 옮긴 것 (ADR-N05).
 *
 * -- 이벤트 lifecycle 상태 컬럼 추가.
 * -- EventCacheRefresher 가 status=IN_PROGRESS 인 이벤트만 백그라운드 갱신 대상으로 삼아
 * -- 캐시 stampede 를 방지 (평가항목 ③).
 */
export class AddEventStatus1756000001000 implements MigrationInterface {
  name = 'AddEventStatus1756000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE event ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'CREATED'`,
    );
    await queryRunner.query(`CREATE INDEX idx_event_status ON event (status)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX idx_event_status ON event`);
    await queryRunner.query(`ALTER TABLE event DROP COLUMN status`);
  }
}
