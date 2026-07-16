import { createServer, type Server } from 'node:http';
import type { Logger } from './logger.js';

export type QueueHealth = 'starting' | 'ready' | 'disabled' | 'error';

export interface HealthSnapshot {
  readonly queue: QueueHealth;
}

export class HealthServer {
  private server: Server | undefined;
  private queueHealth: QueueHealth = 'starting';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly logger: Logger,
  ) {}

  setQueueHealth(queueHealth: QueueHealth): void {
    this.queueHealth = queueHealth;
  }

  snapshot(): HealthSnapshot {
    return { queue: this.queueHealth };
  }

  async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    const server = createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
        return;
      }

      if (request.url === '/healthz') {
        this.sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.url === '/readyz') {
        const ready = this.queueHealth === 'ready';
        this.sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ok' : 'not_ready',
          checks: { queue: this.queueHealth },
        });
        return;
      }

      this.sendJson(response, 404, { error: 'NOT_FOUND' });
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });

    this.server = server;
    this.logger.info('health server listening', {
      host: this.host,
      port: this.port,
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    this.server = undefined;
  }

  private sendJson(
    response: import('node:http').ServerResponse,
    statusCode: number,
    body: Readonly<Record<string, unknown>>,
  ): void {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}
