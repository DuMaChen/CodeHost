/** @type {import('drizzle-kit').Config} */
export default {
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  schemaFilter: ['public'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
};
