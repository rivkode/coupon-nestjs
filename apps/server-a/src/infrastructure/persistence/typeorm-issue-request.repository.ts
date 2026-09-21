import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IssueRequest } from '../../domain/issue-request';
import { IssueRequestRepository } from '../../domain/issue-request.repository';
import { IssueRequestMapper } from './issue-request.mapper';
import { IssueRequestOrmEntity } from './issue-request.orm-entity';

/**
 * 요청 로그를 **요청당 한 번 커밋**한다 (원본 `IssueRequestRepositoryImpl`).
 *
 * 트랜잭션을 열지 않는다 — 쓰기가 하나뿐이라 함께 커밋할 두 번째 쓰기가 없다.
 * `insert()` 를 쓰는 이유는 `save()` 가 존재 확인 SELECT 를 한 번 더 돌리기 때문이다 (핫 경로).
 */
@Injectable()
export class TypeOrmIssueRequestRepository extends IssueRequestRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async save(request: IssueRequest): Promise<IssueRequest> {
    const values = IssueRequestMapper.toInsertValues(request);
    const result = await this.dataSource.manager.insert(
      IssueRequestOrmEntity,
      values,
    );

    // created_at 은 DB DEFAULT 가 채우므로 조회 없이 도메인 모델을 복원한다.
    // 추가 SELECT 를 넣으면 요청당 왕복이 두 번이 된다.
    const insertedId = Number(result.identifiers[0]?.id ?? 0);
    return IssueRequest.reconstitute({
      id: insertedId,
      requestId: request.requestId,
      userId: request.userId,
      eventId: request.eventId,
      couponTypeId: request.couponTypeId,
      status: request.status,
      createdAt: request.createdAt,
    });
  }
}
