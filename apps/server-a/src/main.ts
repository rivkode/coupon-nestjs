import { createValidationPipe, useEnvelopeAwareBodyParser } from '@app/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GlobalExceptionFilter } from './api/filters/global-exception.filter';
import { ServerAModule } from './server-a.module';

/** 원본 `server-a/src/main/resources/application.yml` 의 `server.port: 8080`. */
const PORT = Number(process.env.PORT ?? 8080);

async function bootstrap(): Promise<void> {
  // bodyParser: false — 깨진 JSON 을 MALFORMED_BODY 봉투로 내려면 파서를 직접 소유해야 한다.
  const app = await NestFactory.create(ServerAModule, {
    bufferLogs: false,
    bodyParser: false,
  });
  useEnvelopeAwareBodyParser(app);

  // Spring 의 @Valid + MethodArgumentNotValidException → VALIDATION_FAILED (fieldErrors 포함)
  app.useGlobalPipes(createValidationPipe());
  // @RestControllerAdvice 대응. 봉투 + 에러코드 매핑은 서버마다 다르다 (spec-parity §4).
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ADR-N02: Kafka/Redis 연결을 OnApplicationShutdown 에서 정리하려면 필수.
  // 원본 yml 의 `server.shutdown: graceful` 대응.
  app.enableShutdownHooks();

  await app.listen(PORT);
  new Logger('bootstrap').log(`server-a listening on ${PORT}`);
}

void bootstrap();
