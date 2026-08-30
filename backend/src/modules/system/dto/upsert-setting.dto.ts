import { IsOptional, IsString, IsObject, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertSettingDto {
  @ApiProperty({ description: 'The setting payload (JSON object).' })
  @IsObject()
  value!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Human-readable description.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}
