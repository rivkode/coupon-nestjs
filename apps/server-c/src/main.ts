import { createValidationPipe, useEnvelopeAwareBodyParser } from '@app/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GlobalExceptionFilter } from './api/filters/global-exception.filter';
import { ServerCModule } from './server-c.module';

/** 원본 `server-c/src/main/resources/application.yml` 의 `server.port: 8082`. */
const PORT = Number(process.env.PORT ?? 8082);

async function bootstrap(): Promise<void> {
  // bodyParser: false — 깨진 JSON 을 MALFORMED_BODY 봉투로 내려면 파서를 직접 소유해야 한다.
  const app = await NestFactory.create(ServerCModule, {
    bufferLogs: false,
    bodyParser: false,
  });
  useEnvelopeAwareBodyParser(app);

  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ADR-N02: Kafka consumer/producer 정리 + graceful shutdown.
  app.enableShutdownHooks();

  await app.listen(PORT);
  new Logger('bootstrap').log(`server-c listening on ${PORT}`);
}

void bootstrap();
