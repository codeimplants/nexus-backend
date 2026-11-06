import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
    imports: [AuthModule],
    controllers: [UsersController],
    providers: [UsersService, RolesGuard],
    exports: [UsersService],
})
export class UsersModule {}
