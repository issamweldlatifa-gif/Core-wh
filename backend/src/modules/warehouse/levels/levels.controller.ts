import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LevelsService } from './levels.service';
import { CreateLevelDto } from './dto/create-level.dto';
import { UpdateLevelDto } from './dto/update-level.dto';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../../common/interfaces/request-with-user.interface';

@ApiTags('Levels')
@ApiBearerAuth()
@Controller('levels')
export class LevelsController {
  constructor(private readonly levels: LevelsService) {}

  @Post()
  @RequirePermissions('levels.create')
  @ApiOperation({ summary: 'Create a level (levels.create). Code auto-derived from levelNumber.' })
  create(@Body() dto: CreateLevelDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.levels.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('levels.view')
  @ApiOperation({ summary: 'List levels for a rack (levels.view).' })
  @ApiQuery({ name: 'rackId', required: true })
  list(@Query('rackId') rackId: string) {
    return this.levels.listByRack(rackId);
  }

  @Get(':id')
  @RequirePermissions('levels.view')
  @ApiOperation({ summary: 'Get a level (levels.view).' })
  findOne(@Param('id') id: string) {
    return this.levels.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('levels.update')
  @ApiOperation({ summary: 'Update a level (levels.update).' })
  update(@Param('id') id: string, @Body() dto: UpdateLevelDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.levels.update(id, dto, user.id, req.ip);
  }

  @Post(':id/activate')
  @RequirePermissions('levels.activate')
  @ApiOperation({ summary: 'Activate a level (levels.activate).' })
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.levels.activate(id, user.id, req.ip);
  }

  @Post(':id/deactivate')
  @RequirePermissions('levels.deactivate')
  @ApiOperation({ summary: 'Deactivate a level (levels.deactivate).' })
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.levels.deactivate(id, user.id, req.ip);
  }
}
