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
import { FeatureFlagsService } from './feature-flags.service';
import { CreateFeatureFlagDto, UpdateFeatureFlagDto } from './dto/feature-flag.dto';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AppAccessGuard } from '../../common/guards/app-access.guard';

/**
 * Dashboard CRUD for feature flags.
 *
 * Scoped under an app id and guarded by AppAccessGuard as well as JwtGuard, so a
 * collaborator assigned to one app cannot switch features off in another. The
 * guard reads `appId` from the route params, which is why the create/list routes
 * carry it in the path rather than the body.
 *
 * There is no public read here on purpose. Apps receive flags through
 * /sdk/version/check, which they already call at launch — a second endpoint would
 * be a second thing to fail, and one the SDK would need a release to learn about.
 */
@Controller('admin/apps/:appId/feature-flags')
@UseGuards(JwtGuard, AppAccessGuard)
export class FeatureFlagsController {
  constructor(private flags: FeatureFlagsService) {}

  @Get()
  list(@Param('appId') appId: string) {
    return this.flags.list(appId);
  }

  @Post()
  create(@Param('appId') appId: string, @Body() body: CreateFeatureFlagDto) {
    return this.flags.create(appId, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateFeatureFlagDto) {
    return this.flags.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.flags.remove(id);
  }
}
