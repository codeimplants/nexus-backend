import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { User } from '../../common/decorators/user.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private mfa: MfaService,
  ) { }

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

  // POST /auth/login (email + password) was removed: phone + OTP is the only
  // way in. Sessions last via /auth/refresh, so the OTP is needed rarely.

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

  // ── Authenticator (TOTP) for making changes ───────────────────────────
  // Writes to the caller's own account, so JwtGuard lets them through
  // without an X-MFA-Token (see SELF_SERVICE_WRITES).

  @Get('mfa/status')
  @UseGuards(JwtGuard)
  mfaStatus(@User() user: { id: string }) {
    return this.mfa.status(user.id);
  }

  @Post('mfa/setup')
  @UseGuards(JwtGuard)
  mfaSetup(@User() user: { id: string }) {
    return this.mfa.setup(user.id);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @UseGuards(JwtGuard)
  mfaEnable(@User() user: { id: string }, @Body() body: { code: string }) {
    return this.mfa.enable(user.id, String(body?.code ?? ''));
  }

  /** Authenticator code -> X-MFA-Token, valid 10 minutes for changes. */
  @Post('mfa/verify')
  @HttpCode(200)
  @UseGuards(JwtGuard)
  mfaVerify(@User() user: { id: string }, @Body() body: { code: string }) {
    return this.mfa.verify(user.id, String(body?.code ?? ''));
  }

  /**
   * Lost or new phone: prove the registered number with a login OTP
   * (POST /auth/otp/request first); the authenticator is then cleared and can
   * be set up again. Audited like every other write.
   */
  @Post('mfa/reset')
  @HttpCode(200)
  @UseGuards(JwtGuard)
  async mfaReset(
    @User() user: { id: string },
    @Body() body: { phone: string; sessionId: string; fullhash: string; otp: string },
  ) {
    const owner = await this.auth.confirmPhoneOtp(body);
    if (owner.id !== user.id) throw new ForbiddenException('That phone belongs to another account');
    return this.mfa.clear(user.id);
  }
}
