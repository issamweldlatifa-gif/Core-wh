import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemService } from './system.service';
import { UpsertSettingDto } from './dto/upsert-setting.dto';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../common/interfaces/request-with-user.interface';
import { RequireApplication } from '../../common/decorators/require-application.decorator';

@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
@RequireApplication('ADMIN_WEB')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Public health check.' })
  health() {
    return this.system.health();
  }

  @Get('settings')
  @RequirePermissions('system.view')
  @ApiOperation({ summary: 'List system settings (requires system.view).' })
  listSettings() {
    return this.system.listSettings();
  }

  @Get('settings/:key')
  @RequirePermissions('system.view')
  @ApiOperation({ summary: 'Get a system setting (requires system.view).' })
  getSetting(@Param('key') key: string) {
    return this.system.getSetting(key);
  }

  @Put('settings/:key')
  @RequirePermissions('system.manage')
  @ApiOperation({ summary: 'Upsert a system setting (requires system.manage).' })
  upsertSetting(@Param('key') key: string, @Body() dto: UpsertSettingDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.system.upsertSetting(key, dto.value, dto.description, user.id, req.ip);
  }
}
