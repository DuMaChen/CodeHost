import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg, { type Pool as PgPool, type PoolConfig } from 'pg';
import { schema } from './schema.js';

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
}

export function createPool(config: PoolConfig = {}): PgPool {
  const connectionString = config.connectionString ?? getDatabaseUrl();
  return new Pool({
    ...config,
    connectionString,
  });
}

export function createDatabase(pool: PgPool = createPool()): Database {
  return drizzle(pool, { schema });
}
