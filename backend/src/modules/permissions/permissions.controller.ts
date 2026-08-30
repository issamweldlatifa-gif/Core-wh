import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PermissionsService } from './permissions.service';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

@ApiTags('permissions')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  @RequirePermissions('roles.view')
  @ApiOperation({ summary: 'List all permissions (requires roles.view).' })
  findAll() {
    return this.permissions.findAll();
  }

  @Get(':key')
  @RequirePermissions('roles.view')
  @ApiOperation({ summary: 'Get a permission by key.' })
  findOne(@Param('key') key: string) {
    return this.permissions.findOne(key);
  }
}
