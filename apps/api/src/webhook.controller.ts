import {
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { WebhookService } from './webhook.service.js';

type GiteaWebhook = {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    head?: { sha?: string };
    base?: { sha?: string };
  };
  repository?: { id?: number; full_name?: string };
};

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

export function signatureMatches(rawBody: string, signature: string | undefined): boolean {
  const secret = process.env.GITEA_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = signature.replace(/^sha256=/, '');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

@Controller('/webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('/gitea')
  @HttpCode(202)
  async receive(
    @Body() payload: GiteaWebhook,
    @Headers('x-gitea-signature') signature: string | undefined,
    @Headers('x-gitea-delivery') deliveryId: string | undefined,
    @Req() request: RawBodyRequest,
  ): Promise<{ accepted: true; result: Awaited<ReturnType<WebhookService['accept']>> }> {
    const rawBody = request.rawBody;
    if (!rawBody || !signatureMatches(rawBody.toString('utf8'), signature)) {
      throw new UnauthorizedException('invalid webhook signature');
    }

    const result = await this.webhookService.accept(rawBody, payload, deliveryId);
    if (result.kind === 'replay-rejected') {
      throw new ConflictException('webhook delivery id was reused with a different payload');
    }
    return { accepted: true, result };
  }
}
