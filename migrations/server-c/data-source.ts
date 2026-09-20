import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildMysqlOptions } from '../../libs/common/src/persistence/mysql-options';

loadEnv();

/** TypeORM CLI 전용 DataSource (`npm run migration:c`). 앱 런타임은 TypeOrmModule 이 따로 만든다. */
export default new DataSource(
  buildMysqlOptions({
    database: process.env.DB_NAME_C ?? 'server_c',
    port: Number(process.env.DB_PORT_C ?? 3307),
    entities: [],
    // `data-source.ts` 자신이 글롭에 걸리면 TypeORM 의 디렉터리 로더가 무한 재귀한다 (실제로 겪음).
    // 타임스탬프로 시작하는 마이그레이션 파일만 매칭한다.
    migrations: [`${__dirname}/[0-9]*.ts`],
  }),
);
