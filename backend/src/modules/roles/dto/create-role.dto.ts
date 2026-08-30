import { IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({ type: [String], description: 'Permission keys to grant.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}
