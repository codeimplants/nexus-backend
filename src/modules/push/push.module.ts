import { Module } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';

@Module({
    imports: [AuthModule],
    controllers: [PushController],
    providers: [PushService, PrismaService],
    exports: [PushService],
})
export class PushModule { }
