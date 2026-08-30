import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token issued at login.' })
  @IsString()
  @MinLength(10)
  refreshToken!: string;
}
