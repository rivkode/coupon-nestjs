import type { INestApplication } from '@nestjs/common';
import {
  json,
  urlencoded,
  type ErrorRequestHandler,
  type Express,
} from 'express';
import {
  ApiResponses,
  ERROR_CODE,
  ERROR_MESSAGE,
  ErrorResponses,
} from './api-response';

/**
 * Spring 의 `HttpMessageNotReadableException` → 400 MALFORMED_BODY 를 재현한다 (spec-parity §4).
 *
 * 왜 body parser 를 직접 붙이는가:
 * Nest 기본 파서를 쓰면 깨진 JSON 이 **`BadRequestException` 으로 변환되면서 원인 정보가 지워진다**
 * (확인함 — `cause`/`type`/`body` 전부 사라지고 파서 메시지만 남는다).
 * 그러면 전역 필터에서 "JSON 파싱 실패" 를 구조적으로 판별할 방법이 없어
 * `MALFORMED_BODY` 대신 파서 원문이 그대로 노출된다.
 *
 * 그래서 `NestFactory.create(..., { bodyParser: false })` 로 기본 파서를 끄고,
 * 여기서 express 파서를 직접 붙인 뒤 파싱 에러를 우리 봉투로 응답한다.
 *
 * ⚠️ 이 에러 미들웨어는 Nest 라우터보다 **앞**에 있으므로 전역 ExceptionFilter 를 거치지 않는다.
 *    따라서 봉투를 여기서 직접 만든다. 형태는 필터가 내는 것과 동일해야 한다.
 */
export function useEnvelopeAwareBodyParser(app: INestApplication): void {
  const http = app.getHttpAdapter().getInstance() as Express;

  // 원본 Tomcat `max-http-post-size` 기본값은 2MB. express `json()` 기본 100KB 로 두면
  // 원본이 받아주는 본문을 413 으로 거절한다.
  http.use(json({ limit: '2mb' }));
  http.use(urlencoded({ extended: true }));

  const onParseError: ErrorRequestHandler = (err, _req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res
        .status(400)
        .json(
          ApiResponses.failure(
            ErrorResponses.of(
              ERROR_CODE.MALFORMED_BODY,
              ERROR_MESSAGE.MALFORMED_BODY,
            ),
          ),
        );
      return;
    }
    next(err);
  };
  http.use(onParseError);
}
