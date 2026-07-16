import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseHandle, PLATFORM_DB } from './database.provider.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(PLATFORM_DB) private readonly database: DatabaseHandle | null,
  ) {}

  @Get('/healthz')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('/readyz')
  async ready(): Promise<{ status: 'ok'; checks: { database: 'ok' } }> {
    if (!this.database) {
      throw new ServiceUnavailableException('database is not configured');
    }
    await this.database.pool.query('select 1');
    return { status: 'ok', checks: { database: 'ok' } };
  }
}
