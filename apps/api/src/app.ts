import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { loadConfig } from '@platform/config';
import { AppModule } from './app.module.js';

export async function createApiApp(): Promise<NestFastifyApplication> {
  const config = loadConfig();
  return NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: config.nodeEnv === 'production',
      bodyLimit: 512 * 1024,
    }),
    { rawBody: true },
  );
}
