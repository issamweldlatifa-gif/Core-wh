import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignRolesDto {
  @ApiProperty({ type: [String], description: 'Role names to assign (replaces existing roles).' })
  @IsArray()
  @IsString({ each: true })
  roles!: string[];
}
