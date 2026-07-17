import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  ReviewRequestError,
  parseReviewRequest,
  type ReviewResponse,
} from "./protocol.js";
import { MAX_HTTP_BODY_BYTES } from "./config.js";
import type { AgentReviewService } from "./service.js";

export interface ReviewHttpDependencies {
  readonly service: AgentReviewService;
  readonly ready: () => boolean;
  readonly maxBodyBytes?: number;
}

interface HttpRequestError {
  readonly statusCode: 400 | 413 | 415;
  readonly code: "INVALID_JSON" | "REQUEST_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE";
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(serialized),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(serialized);
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return contentType === undefined || /^application\/json(?:\s*;|\s*$)/i.test(contentType);
}

function readBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  const contentLengthHeader = request.headers["content-length"];
  if (contentLengthHeader !== undefined) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maximumBytes) {
      request.resume();
      return Promise.reject({ statusCode: 413, code: "REQUEST_TOO_LARGE" } satisfies HttpRequestError);
    }
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (error: HttpRequestError | Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maximumBytes) {
        request.resume();
        fail({ statusCode: 413, code: "REQUEST_TOO_LARGE" });
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: Error) => fail(error));
  });
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const body = await readBody(request, maximumBytes);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw { statusCode: 400, code: "INVALID_JSON" } satisfies HttpRequestError;
  }
}

function isHttpRequestError(error: unknown): error is HttpRequestError {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "code" in error &&
    (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)
  );
}

export class ReviewHttpServer {
  private server: Server | undefined;

  constructor(private readonly dependencies: ReviewHttpDependencies) {}

  async start(host: string, port: number): Promise<void> {
    if (this.server !== undefined) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    this.server = server;
  }

  address(): AddressInfo | null {
    const address = this.server?.address();
    return address !== null && typeof address === "object" ? address : null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    this.server = undefined;
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://agent-review").pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      sendJson(response, 200, { service: "agent-review", status: "ok" });
      return;
    }
    if (request.method === "GET" && pathname === "/readyz") {
      const ready = this.dependencies.ready();
      sendJson(response, ready ? 200 : 503, {
        checks: { provider: ready ? "ready" : "starting" },
        status: ready ? "ok" : "not_ready",
      });
      return;
    }
    if (pathname !== "/review") {
      sendJson(response, 404, { error: "NOT_FOUND" });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (!contentTypeIsJson(request)) {
      sendJson(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }

    try {
      const payload = await readJson(
        request,
        this.dependencies.maxBodyBytes ?? MAX_HTTP_BODY_BYTES,
      );
      const reviewRequest = parseReviewRequest(payload);
      const result: ReviewResponse = await this.dependencies.service.review(reviewRequest);
      sendJson(response, 200, result);
    } catch (error: unknown) {
      if (error instanceof ReviewRequestError) {
        sendJson(response, error.statusCode, { error: error.code });
        return;
      }
      if (isHttpRequestError(error)) {
        sendJson(response, error.statusCode, { error: error.code });
        return;
      }
      sendJson(response, 500, { error: "INTERNAL_ERROR" });
    }
  }
}
