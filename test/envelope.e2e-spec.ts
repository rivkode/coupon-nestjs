import {
  CouponCode,
  InvalidStateError,
  UserId,
  assertIssueRequestPayload,
  createValidationPipe,
  useEnvelopeAwareBodyParser,
} from '@app/common';
import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IsInt, IsPositive } from 'class-validator';
import request from 'supertest';
import { GlobalExceptionFilter as FilterA } from '../apps/server-a/src/api/filters/global-exception.filter';
import { GlobalExceptionFilter as FilterB } from '../apps/server-b/src/api/filters/global-exception.filter';
import { GlobalExceptionFilter as FilterC } from '../apps/server-c/src/api/filters/global-exception.filter';
import { CouponNotFoundError } from '../apps/server-c/src/domain/exception/coupon-not-found.error';
import { OptimisticLockFailureError } from '../apps/server-c/src/domain/exception/optimistic-lock-failure.error';

/**
 * 응답 봉투 + 에러코드 매핑을 고정하는 계약 테스트 (spec-parity §3/§4).
 *
 * 실제 컨트롤러가 아직 없으므로 최소 컨트롤러를 세워 **필터/파이프/파서의 동작만** 검증한다.
 * 서버별로 의도적으로 다른 지점(b 의 INTERNAL_STATE, b 의 MISSING_HEADER 부재)을 여기서 못 박는다.
 */

class SampleDto {
  @IsInt()
  @IsPositive()
  eventId!: number;
}

@Controller('t')
class SampleController {
  @Post('validate')
  validate(@Body() dto: SampleDto) {
    return dto;
  }

  @Get('header')
  header(@UserId() userId: number) {
    return { userId };
  }

  @Get('invalid-state')
  invalidState(): never {
    throw new InvalidStateError('coupon is not redeemable: status=USED');
  }

  @Get('not-found')
  notFound(): never {
    throw new CouponNotFoundError('coupon not found: code=ABC');
  }

  @Get('race')
  race(): never {
    throw new OptimisticLockFailureError('version mismatch');
  }

  @Get('boom')
  boom(): never {
    throw new Error('unexpected failure');
  }

  /** 원본 `CouponCode` 의 IllegalArgumentException 경로 */
  @Get('bad-coupon-code')
  badCouponCode(): never {
    CouponCode.of('TOO-SHORT');
    throw new Error('unreachable');
  }

  /** 원본 payload record 의 IllegalArgumentException 경로 */
  @Get('bad-payload')
  badPayload(): never {
    assertIssueRequestPayload({
      requestId: 'req-1',
      userId: -1,
      eventId: 1,
      couponTypeId: 1,
      requestedAt: new Date().toISOString(),
    });
    throw new Error('unreachable');
  }

  /** 원본 payload record 의 Objects.requireNonNull 경로 (NPE → 500) */
  @Get('null-payload')
  nullPayload(): never {
    assertIssueRequestPayload({
      requestId: null as unknown as string,
      userId: 1,
      eventId: 1,
      couponTypeId: 1,
      requestedAt: new Date().toISOString(),
    });
    throw new Error('unreachable');
  }
}

@Module({ controllers: [SampleController] })
class SampleModule {}

async function bootstrap(
  filter: FilterA | FilterB | FilterC,
): Promise<INestApplication> {
  const app = await NestFactory.create(SampleModule, {
    logger: false,
    bodyParser: false,
  });
  useEnvelopeAwareBodyParser(app);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(filter);
  await app.init();
  return app;
}

describe('응답 봉투 / 에러코드 계약', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let appC: INestApplication;

  beforeAll(async () => {
    appA = await bootstrap(new FilterA());
    appB = await bootstrap(new FilterB());
    appC = await bootstrap(new FilterC());
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close(), appC.close()]);
  });

  describe('공통 (server-a 기준)', () => {
    it('깨진 JSON 은 400 MALFORMED_BODY 봉투로 응답한다', async () => {
      const res = await request(appA.getHttpServer())
        .post('/t/validate')
        .set('Content-Type', 'application/json')
        .send('{bad json');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'MALFORMED_BODY', message: 'request body is malformed' },
      });
    });

    it('검증 실패는 400 VALIDATION_FAILED + fieldErrors 를 채운다', async () => {
      const res = await request(appA.getHttpServer())
        .post('/t/validate')
        .send({ eventId: -1 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toBe('request body validation failed');
      expect(res.body.error.fieldErrors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'eventId' })]),
      );
    });

    it('성공 응답에는 error 키가 생략된다', async () => {
      const res = await request(appA.getHttpServer())
        .get('/t/header')
        .set('X-User-Id', '123456');

      expect(res.status).toBe(200);
      // 컨트롤러가 봉투를 직접 씌우지 않는 단계라 data 는 raw — 헤더 파싱만 확인
      expect(res.body).toEqual({ userId: 123456 });
    });

    it('매핑되지 않은 예외는 500 INTERNAL_ERROR 로 마스킹된다', async () => {
      const res = await request(appA.getHttpServer()).get('/t/boom');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'internal server error' },
      });
    });
  });

  describe('X-User-Id 누락 — 서버마다 다르다 (spec-parity §4)', () => {
    it('server-a 는 400 MISSING_HEADER', async () => {
      const res = await request(appA.getHttpServer()).get('/t/header');

      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: 'MISSING_HEADER',
        message: 'required header missing: X-User-Id',
      });
    });

    it('server-c 도 400 MISSING_HEADER', async () => {
      const res = await request(appC.getHttpServer()).get('/t/header');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_HEADER');
    });

    it('server-b 는 핸들러가 없어 500 INTERNAL_ERROR 가 된다 (원본 동작)', async () => {
      const res = await request(appB.getHttpServer()).get('/t/header');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('X-User-Id 변환 — Spring 의 Long 바인딩과 같아야 한다', () => {
    it('숫자가 아니면 400 TYPE_MISMATCH + "argument type mismatch: userId"', async () => {
      const res = await request(appA.getHttpServer())
        .get('/t/header')
        .set('X-User-Id', 'abc');

      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: 'TYPE_MISMATCH',
        message: 'argument type mismatch: userId',
      });
    });

    it('소수점은 Long 이 아니라 400 TYPE_MISMATCH', async () => {
      const res = await request(appA.getHttpServer())
        .get('/t/header')
        .set('X-User-Id', '1.5');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TYPE_MISMATCH');
    });

    it('0 과 음수는 원본이 통과시키므로 우리도 통과시킨다 (범위 검증 추가 금지)', async () => {
      const zero = await request(appA.getHttpServer())
        .get('/t/header')
        .set('X-User-Id', '0');
      const negative = await request(appA.getHttpServer())
        .get('/t/header')
        .set('X-User-Id', '-5');

      expect(zero.status).toBe(200);
      expect(zero.body).toEqual({ userId: 0 });
      expect(negative.status).toBe(200);
      expect(negative.body).toEqual({ userId: -5 });
    });
  });

  describe('도메인 인자 검증 — 예외 종류가 상태코드를 가른다', () => {
    it('CouponCode 길이 위반은 400 INVALID_ARGUMENT + 메시지 그대로 노출', async () => {
      const res = await request(appC.getHttpServer()).get('/t/bad-coupon-code');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ARGUMENT');
      expect(res.body.error.message).toBe(
        'couponCode length must be 12 but was 9',
      );
    });

    it('payload 의 must-be-positive 는 400 INVALID_ARGUMENT', async () => {
      const res = await request(appA.getHttpServer()).get('/t/bad-payload');

      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: 'INVALID_ARGUMENT',
        message: 'userId must be positive: -1',
      });
    });

    it('requireNonNull 상당(NPE)은 원본대로 500 INTERNAL_ERROR 로 마스킹', async () => {
      const res = await request(appA.getHttpServer()).get('/t/null-payload');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('InvalidStateError — 서버마다 다르다 (spec-parity §4)', () => {
    it('server-a 는 409 INVALID_STATE', async () => {
      const res = await request(appA.getHttpServer()).get('/t/invalid-state');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
      expect(res.body.error.message).toBe(
        'coupon is not redeemable: status=USED',
      );
    });

    it('server-c 도 409 INVALID_STATE', async () => {
      const res = await request(appC.getHttpServer()).get('/t/invalid-state');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
    });

    it('server-b 는 500 INTERNAL_STATE (의도된 차이 — 통일하지 말 것)', async () => {
      const res = await request(appB.getHttpServer()).get('/t/invalid-state');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_STATE');
    });
  });

  describe('server-c 전용 매핑', () => {
    it('CouponNotFoundError 는 404 NOT_FOUND 로 메시지를 마스킹한다', async () => {
      const res = await request(appC.getHttpServer()).get('/t/not-found');

      expect(res.status).toBe(404);
      expect(res.body.error).toEqual({
        code: 'NOT_FOUND',
        message: 'coupon not found',
      });
      // 내부 메시지(code=ABC)가 새지 않아야 한다
      expect(JSON.stringify(res.body)).not.toContain('ABC');
    });

    it('OptimisticLockFailureError 는 409 RACE_RETRY (ADR-N03)', async () => {
      const res = await request(appC.getHttpServer()).get('/t/race');

      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({
        code: 'RACE_RETRY',
        message: 'concurrent modification — retry the request',
      });
    });
  });

  describe('ADR-N06 — 프레임워크 오류는 상태코드 유지 + 본문만 봉투', () => {
    it('존재하지 않는 경로는 404 를 유지하고 봉투로 감싼다', async () => {
      const res = await request(appA.getHttpServer()).get('/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
      // Nest 기본 본문({statusCode, message, error})이 새어나오면 안 된다
      expect(res.body).not.toHaveProperty('statusCode');
    });

    it('잘못된 메서드는 405 + METHOD_NOT_ALLOWED 봉투', async () => {
      const res = await request(appA.getHttpServer()).delete('/t/header');

      // express 라우터는 매칭 실패 시 404 를 내므로 405 가 아닐 수 있다 — 봉투 형태만 고정한다
      expect(res.body.success).toBe(false);
      expect(typeof res.body.error.code).toBe('string');
      expect(res.body).not.toHaveProperty('statusCode');
    });
  });
});
