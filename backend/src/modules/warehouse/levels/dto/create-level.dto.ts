import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min } from 'class-validator';

export class CreateLevelDto {
  @ApiProperty({ description: 'Rack id the level belongs to.' })
  @IsString()
  rackId!: string;

  @ApiProperty({ description: 'Numeric level order (1,2,3...). Display code is derived (L01...).' })
  @IsInt()
  @Min(1)
  levelNumber!: number;
}
