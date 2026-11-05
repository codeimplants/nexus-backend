import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtGuard, type JwtPayload } from '../../common/guards/jwt.guard';
import { User } from '../../common/decorators/user.decorator';
import { PushService } from './push.service';

class RegisterDeviceDto {
    @IsString() @MaxLength(200) token!: string;
    @IsIn(['ios', 'android']) platform!: string;
    @IsOptional() @IsString() @MaxLength(100) deviceName?: string;
}

class UnregisterDeviceDto {
    @IsString() @MaxLength(200) token!: string;
}

/** The admin app's phones. Any signed-in admin manages their own; what they receive depends on their role. */
@Controller('admin/push')
@UseGuards(JwtGuard)
export class PushController {
    constructor(private readonly push: PushService) { }

    /** Called by the app after sign-in and whenever Expo hands it a new token. */
    @Post('devices')
    register(@User() user: JwtPayload, @Body() dto: RegisterDeviceDto) {
        return this.push.register(user.id, dto.token, dto.platform, dto.deviceName);
    }

    /** Called by the app on sign-out, so the phone stops getting alerts. */
    @Delete('devices')
    unregister(@User() user: JwtPayload, @Body() dto: UnregisterDeviceDto) {
        return this.push.unregister(user.id, dto.token);
    }

    @Get('devices')
    mine(@User() user: JwtPayload) {
        return this.push.mine(user.id);
    }

    /** Sends a test notification to the caller's own phones. */
    @Post('test')
    async test(@User() user: JwtPayload) {
        const r = await this.push.sendToAdmin(user.id, {
            title: 'Nexus push is working',
            body: 'Server alerts will arrive here.',
            data: { screen: 'alerts' },
        });
        if (!r.devices) return { sent: false, reason: 'No phone registered for this account. Sign in on the Nexus app first.' };
        return { ok: r.sent > 0 && !r.errors.length, ...r };
    }
}
