import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserCouponRepository } from '../domain/user-coupon.repository';
import {
  toUserCouponInternalView,
  toUserCouponView,
  type UserCouponInternalView,
  type UserCouponView,
} from './views';

/**
 * UserCoupon 단건/목록 조회 (원본 `UserCouponQueryService`).
 * internal (server-b 의 스케줄러) + public (사용자 본인 목록) 양쪽의 백엔드다.
 *
 * 읽기 전용이라 `dataSource.manager` 를 그대로 쓴다 — 트랜잭션을 열 이유가 없다.
 */
@Injectable()
export class UserCouponQueryService {
  constructor(
    private readonly repository: UserCouponRepository,
    private readonly dataSource: DataSource,
  ) {}

  /** server-b 스케줄러의 보완 조회용. 없으면 null → 컨트롤러가 404. */
  async findByUserIdAndCouponTypeId(
    userId: number,
    couponTypeId: number,
  ): Promise<UserCouponInternalView | null> {
    const coupon = await this.repository.findByUserIdAndCouponTypeId(
      this.dataSource.manager,
      userId,
      couponTypeId,
    );
    return coupon === null ? null : toUserCouponInternalView(coupon);
  }

  /** `issued_at DESC`. 페이지네이션 없음 — 사용자당 이벤트 상한이 100 이라 응답 크기 한계가 작다. */
  async findAllByUserId(userId: number): Promise<UserCouponView[]> {
    const coupons = await this.repository.findAllByUserId(
      this.dataSource.manager,
      userId,
    );
    return coupons.map((c) => toUserCouponView(c));
  }
}
