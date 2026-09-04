import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiClientsService } from './api-clients.service';
import { RequirePermissions } from '../../../../common/decorators/require-permissions.decorator';
import { IsIn, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RequireApplication } from '../../../../common/decorators/require-application.decorator';

class CreateApiClientDto {
  @ApiProperty() @IsString() @MinLength(2) name!: string;
}
class SetStatusDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] }) @IsIn(['ACTIVE', 'DISABLED']) status!: 'ACTIVE' | 'DISABLED';
}

@ApiTags('api-clients')
@ApiBearerAuth()
@Controller('system/api-clients')
@RequireApplication('ADMIN_WEB')
export class ApiClientsController {
  constructor(private readonly service: ApiClientsService) {}

  @Post()
  @RequirePermissions('api_clients.manage')
  @ApiOperation({ summary: 'Create an API client (requires api_clients.manage).' })
  create(@Body() dto: CreateApiClientDto) {
    return this.service.create(dto.name);
  }

  @Get()
  @RequirePermissions('api_clients.view')
  @ApiOperation({ summary: 'List API clients (requires api_clients.view).' })
  findAll() {
    return this.service.findAll();
  }

  @Patch(':id/status')
  @RequirePermissions('api_clients.manage')
  @ApiOperation({ summary: 'Enable/disable an API client.' })
  setStatus(@Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.service.setStatus(id, dto.status);
  }

  @Delete(':id')
  @RequirePermissions('api_clients.manage')
  @ApiOperation({ summary: 'Delete an API client.' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
