import { buildMysqlOptions } from '@app/common';
import { DataSource } from 'typeorm';
import { CouponTypeInventoryOrmEntity } from '../../apps/server-c/src/infrastructure/persistence/coupon-type-inventory.orm-entity';
import { CouponTypeOrmEntity } from '../../apps/server-c/src/infrastructure/persistence/coupon-type.orm-entity';
import { EventOrmEntity } from '../../apps/server-c/src/infrastructure/persistence/event.orm-entity';
import { OutboxEventOrmEntity } from '../../apps/server-c/src/infrastructure/persistence/outbox-event.orm-entity';
import { TypeOrmCouponTypeInventoryRepository } from '../../apps/server-c/src/infrastructure/persistence/typeorm-coupon-type-inventory.repository';
import { TypeOrmUserCouponRepository } from '../../apps/server-c/src/infrastructure/persistence/typeorm-user-coupon.repository';
import { UserCouponOrmEntity } from '../../apps/server-c/src/infrastructure/persistence/user-coupon.orm-entity';
import { DuplicateUserCouponError } from '../../apps/server-c/src/domain/exception/duplicate-user-coupon.error';
import { UserCoupon } from '../../apps/server-c/src/domain/user-coupon';

/**
 * server-c 영속 계층의 **동시성/멱등성 계약** 통합 테스트.
 *
 * 단위 테스트로는 증명할 수 없는 것들만 다룬다 — 실제 MySQL 의 행 락과 UNIQUE 제약이 필요하다.
 *  - ADR-003: `SELECT ... FOR UPDATE` 가 동시 차감을 직렬화하는가 (oversell 방지)
 *  - ADR-N03: 조건부 UPDATE 가 낙관락으로 동작하는가 (`affected === 0`)
 *  - ADR-004: `(user_id, coupon_type_id)` UNIQUE 만 멱등 신호로 올라오는가
 *
 * 전용 스키마 `server_c_test` 를 쓴다 (개발용 `server_c` 를 오염시키지 않기 위해).
 * 사전 준비: `docker compose up -d` + `DB_NAME_C=server_c_test npm run migration:c`
 */

const EVENT_ID = 900001;
const COUPON_TYPE_ID = 9001;

describe('server-c 영속 계층 (동시성/멱등성)', () => {
  let dataSource: DataSource;
  let userCoupons: TypeOrmUserCouponRepository;
  let inventories: TypeOrmCouponTypeInventoryRepository;

  beforeAll(async () => {
    dataSource = new DataSource(
      buildMysqlOptions({
        database: process.env.DB_NAME_C_TEST ?? 'server_c_test',
        port: Number(process.env.DB_PORT_C ?? 3307),
        entities: [
          EventOrmEntity,
          CouponTypeOrmEntity,
          CouponTypeInventoryOrmEntity,
          UserCouponOrmEntity,
          OutboxEventOrmEntity,
        ],
        migrations: [],
      }),
    );
    await dataSource.initialize();
    userCoupons = new TypeOrmUserCouponRepository();
    inventories = new TypeOrmCouponTypeInventoryRepository();
  }, 30000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    const m = dataSource.manager;
    // FK 순서대로 비운다.
    await m.query('DELETE FROM outbox_event');
    await m.query('DELETE FROM user_coupon');
    await m.query('DELETE FROM coupon_type_inventory');
    await m.query('DELETE FROM coupon_type');
    await m.query('DELETE FROM event');

    await m.query(
      `INSERT INTO event (event_id, name, content, started_at, ended_at, status)
       VALUES (?, 'test event', NULL, '2020-01-01 00:00:00.000', '2099-12-31 23:59:59.000', 'IN_PROGRESS')`,
      [EVENT_ID],
    );
    await m.query(
      `INSERT INTO coupon_type (coupon_type_id, event_id, name, discount_rate) VALUES (?, ?, 'test type', 10)`,
      [COUPON_TYPE_ID, EVENT_ID],
    );
  });

  async function seedInventory(total: number): Promise<void> {
    await dataSource.manager.query(
      `INSERT INTO coupon_type_inventory (event_id, coupon_type_id, total_inventory, available_count)
       VALUES (?, ?, ?, ?)`,
      [EVENT_ID, COUPON_TYPE_ID, total, total],
    );
  }

  async function insertCoupon(params: {
    userId: number;
    code: string;
    status?: 'SUCCESS' | 'SOLD_OUT';
  }): Promise<UserCoupon> {
    await dataSource.transaction(async (tx) => {
      await userCoupons.insert(
        tx,
        UserCoupon.issue({
          code: params.code,
          userId: params.userId,
          eventId: EVENT_ID,
          couponTypeId: COUPON_TYPE_ID,
          status: params.status ?? 'SUCCESS',
          issuedAt: new Date(),
        }),
      );
    });
    const saved = await userCoupons.findByCode(dataSource.manager, params.code);
    if (saved === null) throw new Error('seed failed');
    return saved;
  }

  describe('ADR-003 — 비관적 락이 동시 차감을 직렬화한다', () => {
    it('재고 3 에 동시 요청 10 건이면 정확히 3 건만 성공하고 재고는 0 에서 멈춘다', async () => {
      await seedInventory(3);

      const attempt = async (): Promise<boolean> =>
        dataSource.transaction(async (tx) => {
          const inv = await inventories.findForUpdate(
            tx,
            EVENT_ID,
            COUPON_TYPE_ID,
          );
          if (inv === null) throw new Error('inventory missing');
          if (!inv.decrement()) return false;
          await inventories.updateAvailableCount(tx, inv);
          return true;
        });

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => attempt()),
      );

      expect(outcomes.filter(Boolean)).toHaveLength(3);

      const final = await inventories.findByEventIdAndCouponTypeId(
        dataSource.manager,
        EVENT_ID,
        COUPON_TYPE_ID,
      );
      expect(final?.availableCount).toBe(0);
      // 음수로 내려가지 않는다 — 락이 없으면 여기가 깨진다
      expect(final!.availableCount).toBeGreaterThanOrEqual(0);
    }, 30000);
  });

  describe('ADR-N03 — 조건부 UPDATE 가 낙관락으로 동작한다', () => {
    it('같은 version 으로 두 번 시도하면 첫 번째만 1, 두 번째는 0 을 돌려준다', async () => {
      const coupon = await insertCoupon({ userId: 7001, code: 'RACEAAAAAAAA' });
      expect(coupon.version).toBe(0);

      const first = await userCoupons.markUsed(
        dataSource.manager,
        coupon.id as number,
        coupon.version,
        new Date(),
      );
      const second = await userCoupons.markUsed(
        dataSource.manager,
        coupon.id as number,
        coupon.version, // 같은(이제는 낡은) version
        new Date(),
      );

      expect(first).toBe(1);
      // 여기가 0 이 아니면 @VersionColumn 만 믿은 것과 같아 동시 redeem 이 둘 다 성공한다
      expect(second).toBe(0);
    });

    it('성공하면 version 이 1 증가하고 status 가 USED 로 바뀐다', async () => {
      const coupon = await insertCoupon({ userId: 7002, code: 'VERSIONAAAAA' });
      const usedAt = new Date();

      await userCoupons.markUsed(
        dataSource.manager,
        coupon.id as number,
        coupon.version,
        usedAt,
      );

      const after = await userCoupons.findByCode(
        dataSource.manager,
        'VERSIONAAAAA',
      );
      expect(after?.version).toBe(1);
      expect(after?.status).toBe('USED');
      expect(after?.usedAt).not.toBeNull();
    });

    it('동시 20건에서도 실제 전이는 정확히 1번만 일어난다', async () => {
      const coupon = await insertCoupon({ userId: 7003, code: 'CONCURRENTAA' });

      const wins = await Promise.all(
        Array.from({ length: 20 }, () =>
          userCoupons.markUsed(
            dataSource.manager,
            coupon.id as number,
            coupon.version,
            new Date(),
          ),
        ),
      );

      expect(wins.filter((affected) => affected === 1)).toHaveLength(1);
      const after = await userCoupons.findByCode(
        dataSource.manager,
        'CONCURRENTAA',
      );
      expect(after?.version).toBe(1);
    }, 30000);
  });

  describe('ADR-004 — UNIQUE 제약의 의미를 구분한다', () => {
    it('(user_id, coupon_type_id) 위반은 DuplicateUserCouponError 로 올라온다 (멱등 신호)', async () => {
      await insertCoupon({ userId: 7004, code: 'DUPUSERAAAAA' });

      await expect(
        insertCoupon({ userId: 7004, code: 'DIFFERENTCOD' }),
      ).rejects.toBeInstanceOf(DuplicateUserCouponError);
    });

    it('code UNIQUE 위반은 삼키지 않고 그대로 드러난다 (멱등 신호가 아니다)', async () => {
      await insertCoupon({ userId: 7005, code: 'SAMECODEAAAA' });

      // 다른 user 인데 code 만 충돌 — "이미 발급됨" 으로 오인하면 안 된다
      const promise = insertCoupon({ userId: 7006, code: 'SAMECODEAAAA' });

      await expect(promise).rejects.toThrow();
      await expect(promise).rejects.not.toBeInstanceOf(
        DuplicateUserCouponError,
      );
    });
  });
});
