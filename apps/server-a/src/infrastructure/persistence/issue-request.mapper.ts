import { IssueRequest } from '../../domain/issue-request';
import type { IssueRequestOrmEntity } from './issue-request.orm-entity';

/**
 * ORM 엔티티 ↔ 도메인 모델. **ID 정규화가 일어나는 유일한 지점**이다.
 * mysql2 가 BIGINT 를 string 으로 돌려주므로 여기서 number 로 올린다.
 */
export const IssueRequestMapper = {
  toDomain(row: IssueRequestOrmEntity): IssueRequest {
    return IssueRequest.reconstitute({
      id: Number(row.id),
      requestId: row.requestId,
      userId: Number(row.userId),
      eventId: Number(row.eventId),
      couponTypeId: Number(row.couponTypeId),
      status: row.status,
      createdAt: row.createdAt,
    });
  },

  toInsertValues(request: IssueRequest): Partial<IssueRequestOrmEntity> {
    return {
      requestId: request.requestId,
      userId: String(request.userId),
      eventId: String(request.eventId),
      couponTypeId: String(request.couponTypeId),
      status: request.status,
    };
  },
} as const;
