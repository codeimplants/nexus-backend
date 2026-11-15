import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Put,
    UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../../common/decorators/user.decorator';

@Controller('admin/users')
@UseGuards(JwtGuard)
export class UsersController {
    constructor(private users: UsersService) { }

    /** Any authenticated user can update their own name. */
    @Patch('me')
    updateSelf(
        @User() user: { id: string },
        @Body() dto: { name?: string },
    ) {
        return this.users.updateSelf(user.id, dto);
    }

    // ── Admin-only routes ──────────────────────────────────────────────────

    @Get()
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    findAll() {
        return this.users.findAll();
    }

    @Get(':id')
    @UseGuards(RolesGuard)
    @Roles('ADMIN')
    findOne(@Param('id') id: string) {
        return this.users.findOne(id);
    }

    @Post()
    @UseGuards(RolesGuard)
    @Roles('SUPER_ADMIN')
    create(@Body() dto: CreateUserDto) {
        return this.users.create(dto);
    }

    @Put(':id')
    @UseGuards(RolesGuard)
    @Roles('SUPER_ADMIN')
    update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
        return this.users.update(id, dto);
    }

    @Delete(':id')
    @UseGuards(RolesGuard)
    @Roles('SUPER_ADMIN')
    remove(@Param('id') id: string) {
        return this.users.remove(id);
    }

    /** Clear someone's authenticator (lost phone) so they can set it up again. */
    @Post(':id/mfa/reset')
    @UseGuards(RolesGuard)
    @Roles('SUPER_ADMIN')
    resetMfa(@Param('id') id: string) {
        return this.users.resetMfa(id);
    }

    @Put(':id/deactivate')
    @UseGuards(RolesGuard)
    @Roles('SUPER_ADMIN')
    deactivate(@Param('id') id: string) {
        return this.users.deactivate(id);
    }
}
