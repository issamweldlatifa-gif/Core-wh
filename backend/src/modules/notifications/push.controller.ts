import { Body, Controller, Delete, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { PushService } from './push.service';

/**
 * Push token registration for the native Worker App.
 *
 * The app registers its FCM token after login and drops it on logout, so the
 * backend can reach the handset while the app is backgrounded or closed.
 * Worker surface only — no permission beyond a valid worker session is
 * required to register YOUR OWN device; the audience filtering happens when
 * a message is sent, not when a token is stored.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@RequireApplication('WORKER_NATIVE')
export class PushController {
  constructor(private readonly push: PushService) {}

  private userId(req: any) {
    return String(req.user?.id ?? req.user?.sub ?? 'unknown');
  }

  @Post('push-token')
  @ApiOperation({ summary: 'Register or refresh this device’s push token.' })
  register(@Req() req: any, @Body() body: { token: string; platform?: string; deviceId?: string }) {
    return this.push
      .register(this.userId(req), body?.token, body?.platform ?? 'ANDROID', body?.deviceId)
      .then(() => ({ registered: true }));
  }

  @Delete('push-token')
  @ApiOperation({ summary: 'Remove this device’s push token (logout).' })
  unregister(@Body() body: { token: string }) {
    return this.push.unregister(body?.token).then(() => ({ registered: false }));
  }
}
