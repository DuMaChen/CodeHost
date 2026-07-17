declare module "pg-boss" {
  export default class PgBoss {
    constructor(options: { connectionString: string });
    start(): Promise<void>;
    stop(): Promise<void>;
    createQueue(queueName: string): Promise<void>;
    work<T>(
      queueName: string,
      handler: (job: { readonly data: T } | readonly { readonly data: T }[]) => Promise<void>,
    ): Promise<unknown>;
    send<T>(queueName: string, data: T, options: Readonly<Record<string, unknown>>): Promise<string | null>;
  }
}
