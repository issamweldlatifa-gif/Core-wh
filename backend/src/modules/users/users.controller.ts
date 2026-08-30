import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AssignRolesDto } from './dto/assign-roles.dto';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../common/interfaces/request-with-user.interface';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Create a user (requires users.manage).' })
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.users.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('users.view')
  @ApiOperation({ summary: 'List users (requires users.view).' })
  findAll() {
    return this.users.findAll();
  }

  @Get(':id')
  @RequirePermissions('users.view')
  @ApiOperation({ summary: 'Get a user (requires users.view).' })
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Update a user (requires users.manage).' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.users.update(id, dto, user.id, req.ip);
  }

  @Put(':id/roles')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Assign roles to a user (requires users.manage).' })
  assignRoles(@Param('id') id: string, @Body() dto: AssignRolesDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.users.assignRoles(id, dto.roles, user.id, req.ip);
  }

  @Delete(':id')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Disable a user (requires users.manage).' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.users.remove(id, user.id, req.ip);
  }
}
