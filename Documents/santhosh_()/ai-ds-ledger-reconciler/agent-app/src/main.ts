import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import * as os from 'os';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // os.hostname() inside a container == the container/replica id, so it
  // uniquely identifies WHICH of the scaled agent-app instances we are.
  const instance = os.hostname();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Stamp every response with the serving instance and log inbound traffic so
  // you can watch nginx round-robin across the 3 replicas in the console.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Instance-Name', instance);
    Logger.log(`${req.method} ${req.originalUrl}`, `instance:${instance}`);
    next();
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`agent-app replica "${instance}" listening on :${port}`, 'Bootstrap');
}

bootstrap();
