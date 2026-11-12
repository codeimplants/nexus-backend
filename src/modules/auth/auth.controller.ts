import { Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { User } from '../../common/decorators/user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) { }

  /** Primary console login: send an OTP to a registered admin phone. */
  @Post('otp/request')
  requestOtp(@Body() body: { phone: string }) {
    return this.auth.requestOtp(body.phone);
  }

  /** Verify the OTP and issue the same JWT the rest of the platform consumes. */
  @Post('otp/verify')
  verifyOtp(
    @Body() body: { phone: string; sessionId: string; fullhash: string; otp: string; refreshable?: boolean },
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.auth.verifyOtp(body, userAgent);
  }

  /**
   * Rotate a refresh token into a fresh access + refresh pair. Unguarded on
   * purpose: it is called exactly when the access token has expired. The
   * refresh token itself is the credential.
   */
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body() body: { refreshToken: string },
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.auth.refresh(body?.refreshToken, userAgent);
  }

  /** Revoke the session server-side. Works even if the access token has expired. */
  @Post('logout')
  @HttpCode(200)
  logout(@Body() body: { refreshToken?: string }) {
    return this.auth.logout(body?.refreshToken);
  }

  /** Secondary login, disabled by setting ALLOW_PASSWORD_LOGIN=false. */
  @Post('login')
  login(
    @Body() body: { email: string; password: string; refreshable?: boolean },
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.auth.login(body.email, body.password, userAgent, body.refreshable === true);
  }

  // POST /auth/register is deliberately absent.
  //
  // It existed, unguarded, and created an admin with role: 'ADMIN' hardcoded,
  // returning a signed token straight back. Anyone who could reach this service
  // could make themselves a full administrator of the platform — and with it,
  // every app's API key, every version rule, and the kill switch for all of
  // them. Nothing in the dashboard ever called it.
  //
  // Creating an admin belongs behind an existing admin: POST /admin/users,
  // which is guarded by JwtGuard + RolesGuard('ADMIN'). Do not reinstate a
  // self-service registration route on this service.

  @Get('me')
  @UseGuards(JwtGuard)
  me(@User() user: { id: string }) {
    return this.auth.me(user.id);
  }
}