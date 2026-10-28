import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import express from 'express';
import { Readable } from 'stream';
import { onRequest } from 'firebase-functions/v2/https';

const expressApp = express();

// Firebase Functions buffers the entire request body into req.rawBody before
// passing the request to Express, which consumes the stream. Multer then reads
// an empty stream and throws "Unexpected end of form". This middleware
// reconstructs a readable stream from rawBody so multer can parse multipart.
expressApp.use((req: any, _res: any, next: any) => {
  if (
    req.rawBody &&
    req.headers['content-type']?.includes('multipart/form-data')
  ) {
    const stream = new Readable();
    stream.push(req.rawBody);
    stream.push(null);
    const originalOn = req.on.bind(req);
    req.pipe = stream.pipe.bind(stream);
    req.resume = stream.resume.bind(stream);
    req.on = (event: string, listener: (...args: any[]) => void) => {
      const streamEvents = ['data', 'end', 'close', 'error', 'readable'];
      if (streamEvents.includes(event)) {
        stream.on(event, listener);
      } else {
        originalOn(event, listener);
      }
      return req;
    };
  }
  next();
});

let isInitialized = false;

async function bootstrap() {
  if (isInitialized) return;
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
    {
      logger: ['error', 'warn'],
    },
  );
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    // FRONTEND_URL aceita várias origens separadas por vírgula.
    origin: (process.env.FRONTEND_URL || 'https://my-store-prd.web.app')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  });
  await app.init();
  isInitialized = true;
}

export const api = onRequest(
  { region: 'southamerica-east1', memory: '512MiB', timeoutSeconds: 60 },
  async (req, res) => {
    await bootstrap();
    expressApp(req, res);
  },
);
