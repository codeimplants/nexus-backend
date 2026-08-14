import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
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
    @Body() body: { phone: string; sessionId: string; fullhash: string; otp: string },
  ) {
    return this.auth.verifyOtp(body);
  }

  /** Secondary login, disabled by setting ALLOW_PASSWORD_LOGIN=false. */
  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body.email, body.password);
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