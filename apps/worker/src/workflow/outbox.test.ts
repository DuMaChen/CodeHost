import { describe, expect, it } from "vitest";
import { OutboxPublisher } from "./outbox.js";
import { Logger } from "../logger.js";

type FakeRow = {
  id: string;
  runId: string;
  attempt: number;
  stepKey: string;
  queueName: string;
  payloadJson: Record<string, unknown>;
  status: "PENDING" | "PUBLISHED" | "FAILED";
  availableAt: Date;
  publishedAt: Date | null;
  attempts: number;
  leaseUntil: Date | null;
  lastError: string | null;
};

class FakeOutboxDatabase {
  readonly row: FakeRow = {
    id: "outbox-1",
    runId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    stepKey: "detect",
    queueName: "platform.workflow",
    payloadJson: {
      runId: "11111111-1111-4111-8111-111111111111",
      attempt: 1,
      headSha: "a".repeat(40),
      stepKey: "detect",
    },
    status: "PENDING",
    availableAt: new Date(Date.now() - 1),
    publishedAt: null,
    attempts: 0,
    leaseUntil: null,
    lastError: null,
  };

  select() {
    return {
      from: () => ({
        where: () => ({
          limit: async () => [this.row],
        }),
      }),
    };
  }

  transaction<T>(callback: (transaction: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  execute(): Promise<void> {
    return Promise.resolve();
  }

  update() {
    return {
      set: (changes: Partial<FakeRow>) => ({
        where: async () => {
          Object.assign(this.row, changes);
          return [];
        },
      }),
    };
  }
}

describe("workflow outbox recovery", () => {
  it("retries a failed dispatch and publishes it once after recovery", async () => {
    const database = new FakeOutboxDatabase();
    let dispatches = 0;
    let failFirst = true;
    const dispatcher = {
      dispatch: async () => {
        dispatches += 1;
        if (failFirst) {
          failFirst = false;
          throw new Error("simulated worker crash");
        }
      },
    };
    const publisher = new OutboxPublisher(database as never, dispatcher, new Logger("test"));

    await publisher.start();
    await publisher.stop();
    expect(dispatches).toBe(1);
    expect(database.row.status).toBe("FAILED");
    expect(database.row.lastError).toBe("simulated worker crash");

    database.row.availableAt = new Date(Date.now() - 1);
    database.row.leaseUntil = null;
    await publisher.start();
    await publisher.stop();
    expect(dispatches).toBe(2);
    expect(database.row.status).toBe("PUBLISHED");
    expect(database.row.leaseUntil).toBeNull();

    await publisher.start();
    await publisher.stop();
    expect(dispatches).toBe(2);
  });
});
