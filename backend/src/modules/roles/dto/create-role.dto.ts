import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const ROLE_APPLICATION_CLASSES = ['ADMIN', 'OPERATIONAL', 'VIEWER', 'UNKNOWN'] as const;

export class CreateRoleDto {
  @ApiProperty({ description: 'Role name, e.g. INBOUND_WORKER.' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[A-Z0-9_]+$/, { message: 'Role name must be uppercase letters, numbers and underscores.' })
  name!: string;

  @ApiPropertyOptional({ description: 'Role description.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({
    enum: [...ROLE_APPLICATION_CLASSES],
    description:
      'Which application surface this role opens (server truth, data-driven). ' +
      'ADMIN/VIEWER → Admin Web; OPERATIONAL → Worker Native app. ' +
      'Leave UNKNOWN only for roles that should open nothing until assigned.',
  })
  @IsOptional()
  @IsIn([...ROLE_APPLICATION_CLASSES])
  applicationClass?: (typeof ROLE_APPLICATION_CLASSES)[number];

  @ApiPropertyOptional({ type: [String], description: 'Permission keys to grant.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}
