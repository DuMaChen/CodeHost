import { createDatabase, createPool, type Database } from '@platform/db';
import type { Pool } from 'pg';
import { PLATFORM_DB } from './tokens.js';

export { PLATFORM_DB } from './tokens.js';

export class DatabaseHandle {
  private constructor(
    readonly db: Database,
    readonly pool: Pool,
  ) {}

  static create(databaseUrl: string): DatabaseHandle {
    const pool = createPool({ connectionString: databaseUrl });
    return new DatabaseHandle(createDatabase(pool), pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
