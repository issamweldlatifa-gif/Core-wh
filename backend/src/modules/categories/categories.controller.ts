import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CategoriesService } from './categories.service';

class CreateCategoryDto {
  @IsString() @MinLength(2) @MaxLength(40)
  code!: string;

  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  subcategories?: string[];
}

class UpdateCategoryDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  subcategories?: string[];
}

class SetStatusDto {
  @IsString() @IsIn(['ACTIVE', 'INACTIVE'])
  status!: 'ACTIVE' | 'INACTIVE';
}

class SetMappingDto {
  @IsString() @MinLength(1)
  zoneId!: string;
}

/**
 * Category Master + Category -> Zone sorting configuration.
 * Reuses the existing inventory.* permission keys (categories are inventory
 * vocabulary): view -> inventory.view, mutations -> inventory.manage.
 */
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  private actor(req: any, ip: string) {
    return { id: req.user?.id ?? null, ip };
  }

  @Get()
  @RequirePermissions('inventory.view')
  @ApiOperation({ summary: 'List the Category Master with zone mappings.' })
  list(@Query('active') active?: string) {
    return this.categories.list(active !== 'true');
  }

  @Post()
  @RequirePermissions('inventory.manage')
  @ApiOperation({ summary: 'Create a category in the master (audited).' })
  create(@Body() dto: CreateCategoryDto, @Req() req: any, @Ip() ip: string) {
    return this.categories.create(dto, this.actor(req, ip));
  }

  @Patch(':id')
  @RequirePermissions('inventory.manage')
  @ApiOperation({ summary: 'Update a category name/subcategories (audited).' })
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto, @Req() req: any, @Ip() ip: string) {
    return this.categories.update(id, dto, this.actor(req, ip));
  }

  @Post(':id/status')
  @RequirePermissions('inventory.manage')
  @ApiOperation({ summary: 'Activate/deactivate a category (audited).' })
  setStatus(@Param('id') id: string, @Body() dto: SetStatusDto, @Req() req: any, @Ip() ip: string) {
    return this.categories.setStatus(id, dto.status as never, this.actor(req, ip));
  }

  @Post(':id/zone-mapping')
  @RequirePermissions('inventory.manage')
  @ApiOperation({ summary: 'Set the sorting destination zone for a category (configuration, audited).' })
  setMapping(@Param('id') id: string, @Body() dto: SetMappingDto, @Req() req: any, @Ip() ip: string) {
    return this.categories.setZoneMapping(id, dto.zoneId, this.actor(req, ip));
  }

  @Delete(':id/zone-mapping/:zoneId')
  @RequirePermissions('inventory.manage')
  @ApiOperation({ summary: 'Remove a category -> zone mapping (audited).' })
  removeMapping(@Param('id') id: string, @Param('zoneId') zoneId: string, @Req() req: any, @Ip() ip: string) {
    return this.categories.removeZoneMapping(id, zoneId, this.actor(req, ip));
  }
}
