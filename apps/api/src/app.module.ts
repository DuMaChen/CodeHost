import { Module } from '@nestjs/common';
import { loadConfig, type AppConfig } from '@platform/config';
import { HealthController } from './health.controller.js';
import { WebhookController } from './webhook.controller.js';
import { DatabaseHandle, PLATFORM_DB } from './database.provider.js';
import { WebhookService } from './webhook.service.js';
import { PLATFORM_CONFIG } from './tokens.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { RunController } from './run.controller.js';

const configProvider = {
  provide: PLATFORM_CONFIG,
  useFactory: (): AppConfig => loadConfig(),
};

const databaseProvider = {
  provide: PLATFORM_DB,
  inject: [PLATFORM_CONFIG],
  useFactory: (config: AppConfig): DatabaseHandle => DatabaseHandle.create(config.databaseUrl),
};

@Module({
  controllers: [HealthController, WebhookController, AuthController, RunController],
  providers: [configProvider, databaseProvider, WebhookService, AuthService],
  exports: [PLATFORM_CONFIG, PLATFORM_DB],
})
export class AppModule {}
