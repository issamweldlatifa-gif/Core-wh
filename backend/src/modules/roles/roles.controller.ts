import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../common/interfaces/request-with-user.interface';

@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post()
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Create a role (requires roles.manage).' })
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.roles.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('roles.view')
  @ApiOperation({ summary: 'List roles (requires roles.view).' })
  findAll() {
    return this.roles.findAll();
  }

  @Get(':id')
  @RequirePermissions('roles.view')
  @ApiOperation({ summary: 'Get a role (requires roles.view).' })
  findOne(@Param('id') id: string) {
    return this.roles.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Update a role (requires roles.manage).' })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.roles.update(id, dto, user.id, req.ip);
  }

  @Put(':id/permissions')
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Assign permissions to a role (requires roles.manage).' })
  assignPermissions(@Param('id') id: string, @Body() dto: AssignPermissionsDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.roles.grantPermissions(id, dto.permissions, user.id, req.ip);
  }

  @Delete(':id')
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Delete a custom role (requires roles.manage).' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.roles.remove(id, user.id, req.ip);
  }
}
