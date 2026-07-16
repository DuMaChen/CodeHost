import { createApiApp } from './app.js';

async function bootstrap(): Promise<void> {
  const app = await createApiApp();

  await app.listen({
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
  });
}

void bootstrap();
