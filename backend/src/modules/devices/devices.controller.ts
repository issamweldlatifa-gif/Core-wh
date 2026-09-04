import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DeviceStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { DevicesService } from './devices.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

function actorOf(req: any) {
  return { id: String(req.user?.id ?? 'unknown'), ip: req.ip ?? undefined };
}

class ChangeDeviceStatusDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] })
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: DeviceStatus;
}

class AssignDeviceWorkerDto {
  @ApiPropertyOptional({ description: 'Worker id to bind, or null to unbind.' })
  @IsOptional()
  @IsString()
  workerId?: string | null;
}

/**
 * Device registry — ADMIN_WEB surface only (strict Admin/Worker isolation).
 * Read gated by stations.view (device registry is workforce vocabulary),
 * writes gated by stations.manage (mirrors station management semantics).
 */
@ApiTags('Devices')
@ApiBearerAuth()
@Controller('devices')
@RequireApplication('ADMIN_WEB')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'List registered worker devices (admin).' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'DISABLED'] })
  @ApiQuery({ name: 'workerId', required: false })
  list(@Query('status') status?: DeviceStatus, @Query('workerId') workerId?: string) {
    return this.devices.list({ status, assignedWorkerId: workerId });
  }

  @Get(':idOrCode')
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'Get one device by id or code.' })
  one(@Param('idOrCode') idOrCode: string) {
    return this.devices.findOne(idOrCode);
  }

  @Post()
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Register a device.' })
  create(@Body() dto: CreateDeviceDto, @Req() req: any) {
    const a = actorOf(req);
    return this.devices.create(dto, a.id, a.ip);
  }

  @Patch(':id')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Update device metadata.' })
  update(@Param('id') id: string, @Body() dto: UpdateDeviceDto, @Req() req: any) {
    const a = actorOf(req);
    return this.devices.update(id, dto, a.id, a.ip);
  }

  @Post(':id/status')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Activate/disable a device. Disabling revokes its live sessions.' })
  status(@Param('id') id: string, @Body() dto: ChangeDeviceStatusDto, @Req() req: any) {
    const a = actorOf(req);
    return this.devices.changeStatus(id, dto.status, a.id, a.ip);
  }

  @Post(':id/assign')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Bind a device to a worker (or unbind with null).' })
  assign(@Param('id') id: string, @Body() dto: AssignDeviceWorkerDto, @Req() req: any) {
    const a = actorOf(req);
    return this.devices.assignWorker(id, dto.workerId ?? null, a.id, a.ip);
  }
}
