import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class UpdateLevelDto {
  @ApiPropertyOptional({ description: 'Numeric level order (1,2,3...). Display code re-derived.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  levelNumber?: number;
}
