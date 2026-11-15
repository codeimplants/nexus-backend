import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    UseGuards,
} from '@nestjs/common';
import { HardeningService } from './hardening.service';
import { CreateHardeningItemDto, UpdateHardeningItemDto } from './dto/hardening.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User } from '../../common/decorators/user.decorator';

/** Shape of the request user the JwtGuard attaches. */
interface RequestUser {
    id: string;
    email: string;
    name?: string | null;
    role: string;
}

/**
 * The Platform Hardening register: infrastructure gaps, the risk each carries
 * once we have paying users, and a pasteable brief per item.
 *
 * Not app-scoped, so there is no AppAccessGuard here — these items are about the
 * platform the apps sit on, not any one app.
 *
 * ADMIN and COLLABORATOR both get full access on purpose. The register exists so
 * a teammate can claim an item and start it in their own AI session, which means
 * they must be able to set a status and an owner; a read-only register is a
 * document, and we already had one of those. LEAD_GEN is excluded — the role has
 * no engineering remit and the briefs name hosts, paths and scripts.
 */
@Controller('admin/hardening')
@UseGuards(JwtGuard, RolesGuard)
@Roles('ADMIN', 'COLLABORATOR')
export class HardeningController {
    constructor(private hardening: HardeningService) { }

    @Get()
    list() {
        return this.hardening.list();
    }

    @Get('summary')
    summary() {
        return this.hardening.summary();
    }

    /** Creating items is ADMIN-only: the list is curated, not crowd-sourced. */
    @Post()
    @Roles('ADMIN')
    create(@Body() body: CreateHardeningItemDto) {
        return this.hardening.create(body);
    }

    /**
     * The route param is `itemId`, not `id`.
     *
     * Nothing here resolves an app, so `id` would not break this controller — but
     * AppAccessGuard elsewhere in this codebase reads `req.params.id` as an app
     * id, and a route in this repo naming a non-app id `id` is the exact mistake
     * that shipped a 404 on every feature-flag update. Keeping the convention
     * means a future guard added to this controller cannot repeat it.
     */
    @Patch(':itemId')
    update(
        @Param('itemId') itemId: string,
        @Body() body: UpdateHardeningItemDto,
        @User() user: RequestUser,
    ) {
        // completedBy is recorded from the token, never from the body.
        return this.hardening.update(itemId, body, user?.name || user?.email);
    }

    @Delete(':itemId')
    @Roles('ADMIN')
    remove(@Param('itemId') itemId: string) {
        return this.hardening.remove(itemId);
    }
}
