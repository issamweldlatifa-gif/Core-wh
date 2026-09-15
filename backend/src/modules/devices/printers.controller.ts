import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuditService } from '../audit/audit.service';

/**
 * PRINTER MANAGER — server-side companion (OWNER TASK 2026-09-15, §22/§23).
 *
 * The physical Bluetooth link is LOCAL to the Honeywell CT40 (the print
 * bridge in the worker app owns it) — NO print commands ever touch this API.
 * The admin web reports printer lifecycle events here so they land in the
 * EXISTING audit system (PRINTER_ADDED/CONNECTED/DISCONNECTED/REMOVED/
 * TEST_PRINTED/CONFIGURATION_CHANGED, PRINT_FAILED) with the acting admin,
 * printer identity and result. Metadata keeps only non-sensitive fields.
 */
export const PRINTER_AUDIT_EVENTS = [
  'PRINTER_ADDED',
  'PRINTER_CONNECTED',
  'PRINTER_DISCONNECTED',
  'PRINTER_REMOVED',
  'PRINTER_TEST_PRINTED',
  'PRINTER_CONFIGURATION_CHANGED',
  'PRINT_FAILED',
] as const;

export type PrinterAuditEvent = (typeof PRINTER_AUDIT_EVENTS)[number];

class PrinterAuditDto {
  @IsIn(PRINTER_AUDIT_EVENTS as unknown as string[])
  event!: PrinterAuditEvent;

  @IsString()
  @MaxLength(60)
  printerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  firmware?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  detail?: string;
}

@ApiTags('Printers')
@ApiBearerAuth()
@Controller('printers')
@RequireApplication('ADMIN_WEB')
export class PrintersController {
  constructor(private readonly audit: AuditService) {}

  private actor(req: any) {
    return { id: String(req.user?.id ?? 'unknown'), ip: req.ip ?? undefined };
  }

  @Post('audit')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Record a printer lifecycle event in the audit trail (from the CT40 admin).' })
  async report(@Body() dto: PrinterAuditDto, @Req() req: any) {
    const actor = this.actor(req);
    await this.audit.log({
      actorUserId: actor.id,
      action: dto.event as never,
      entityType: 'printer',
      entityId: dto.address || dto.printerName,
      ipAddress: actor.ip,
      metadata: {
        printerName: dto.printerName,
        address: dto.address ?? null,
        model: dto.model ?? null,
        firmware: dto.firmware ?? null,
        detail: dto.detail ?? null,
      },
    });
    return { ok: true as const };
  }
}
