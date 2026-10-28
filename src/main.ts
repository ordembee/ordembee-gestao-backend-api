import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: a rota interna (/internal/*) confere a assinatura HMAC sobre o corpo cru.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.enableCors({
    // FRONTEND_URL aceita várias origens separadas por vírgula.
    origin: (process.env.FRONTEND_URL || 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
  logger.log(`Application running on: ${await app.getUrl()}`);
}
bootstrap();
