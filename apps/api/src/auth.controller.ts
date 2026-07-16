import { Controller, Get, Headers, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('/auth/login')
  async login(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.auth.beginLogin(request, reply);
  }

  @Get('/auth/callback')
  async callback(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
  ): Promise<void> {
    await this.auth.finishLogin(request, reply, code, state);
  }

  @Get('/auth/logout')
  async logout(@Headers('cookie') cookie: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    await this.auth.logout(cookie);
    this.auth.setLoggedOutCookie(reply);
    reply.redirect('/');
  }

  @Get('/api/me')
  async me(@Headers('cookie') cookie: string | undefined): Promise<
    | { authenticated: false; user: null }
    | { authenticated: true; user: { id: string; username: string; displayName: string }; csrfToken: string }
  > {
    const session = await this.auth.current(cookie);
    if (!session) return { authenticated: false, user: null };
    const user = await this.auth.fetchUser(session.accessToken);
    return {
      authenticated: true,
      csrfToken: await this.auth.csrfToken(cookie),
      user: {
        id: String(user.id),
        username: user.login,
        displayName: user.fullName ?? user.login,
      },
    };
  }
}
