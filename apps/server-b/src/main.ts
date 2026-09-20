import { createValidationPipe, useEnvelopeAwareBodyParser } from '@app/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GlobalExceptionFilter } from './api/filters/global-exception.filter';
import { ServerBModule } from './server-b.module';

/** 원본 `server-b/src/main/resources/application.yml` 의 `server.port: 8081`. */
const PORT = Number(process.env.PORT ?? 8081);

async function bootstrap(): Promise<void> {
  // bodyParser: false — 깨진 JSON 을 MALFORMED_BODY 봉투로 내려면 파서를 직접 소유해야 한다.
  const app = await NestFactory.create(ServerBModule, {
    bufferLogs: false,
    bodyParser: false,
  });
  useEnvelopeAwareBodyParser(app);

  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ADR-N02: Kafka producer/consumer 를 OnApplicationShutdown 에서 disconnect 하려면 필수.
  // 빠지면 consumer 가 rebalance 를 남기고 죽는다.
  app.enableShutdownHooks();

  await app.listen(PORT);
  new Logger('bootstrap').log(`server-b listening on ${PORT}`);
}

void bootstrap();
