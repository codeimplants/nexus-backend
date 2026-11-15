import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { MfaService } from './mfa.service';

@Module({
    imports: [
        JwtModule.register({
            secret: process.env.JWT_SECRET || 'change-me-in-production',
            // Short-lived: a leaked access token is useful for minutes, not days.
            // Sessions persist via the rotating refresh token instead.
            signOptions: { expiresIn: '15m' },
        }),
    ],
    controllers: [AuthController],
    providers: [AuthService, MfaService, JwtGuard],
    exports: [JwtModule, JwtGuard, MfaService],
})
export class AuthModule { }
