import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ListAuditDto } from './dto/list-audit.dto';
import { AuditAction } from '@prisma/client';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
@RequirePermissions('audit.view')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'List audit log entries (requires audit.view).' })
  list(@Query() query: ListAuditDto) {
    return this.audit.list({
      actorUserId: query.actorUserId,
      action: query.action ? (query.action as AuditAction) : undefined,
      entityType: query.entityType,
      skip: query.skip,
      take: query.take,
    });
  }
}
