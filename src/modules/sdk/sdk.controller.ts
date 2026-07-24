import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { SdkService } from './sdk.service';
import { VersionCheckDto } from './dto/version-check.dto';
import { IngestEventsDto } from './dto/event.dto';
import { IdentifyDto } from './dto/identify.dto';
import { DeviceRegisterDto } from './dto/device.dto';

@Controller('sdk')
export class SdkController {
    constructor(private sdk: SdkService) { }

    /**
     * FROZEN CONTRACT — do not change the request or response shape.
     *
     * Every app already published to the stores calls this endpoint through
     * @codeimplants/version-control, and those binaries cannot be updated on
     * demand. It also delivers force-update and the kill switch, so breaking it
     * disables the only mechanism for fixing a bad release.
     *
     * Additive changes (new OPTIONAL request fields, new response fields) are
     * safe. Anything else needs a new version at /sdk/v1/*.
     * See docs/api-versioning.md.
     */
    @Post('version/check')
    checkVersion(
        @Headers('x-api-key') apiKey: string,
        @Body() body: VersionCheckDto,
    ) {
        return this.sdk.checkVersion(apiKey, body);
    }

    /** Register/refresh this device (backs install counts + make/model split). */
    @Post('device')
    @HttpCode(202)
    registerDevice(
        @Headers('x-api-key') apiKey: string,
        @Body() body: DeviceRegisterDto,
    ) {
        return this.sdk.registerDevice(apiKey, body);
    }

    /** Batched engagement events (app_open / app_background / login_success / ...). */
    @Post('events')
    @HttpCode(202)
    ingestEvents(
        @Headers('x-api-key') apiKey: string,
        @Body() body: IngestEventsDto,
    ) {
        return this.sdk.ingestEvents(apiKey, body);
    }

    /** Link a device to a logged-in end user (any auth method). */
    @Post('user/identify')
    @HttpCode(202)
    identifyUser(
        @Headers('x-api-key') apiKey: string,
        @Body() body: IdentifyDto,
    ) {
        return this.sdk.identifyUser(apiKey, body);
    }

    @Get('stats')
    getStats(@Headers('x-api-key') apiKey: string) {
        return this.sdk.getAppStats(apiKey);
    }
}