import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignPermissionsDto {
  @ApiProperty({ type: [String], description: 'Permission keys to grant (replaces existing).' })
  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}
