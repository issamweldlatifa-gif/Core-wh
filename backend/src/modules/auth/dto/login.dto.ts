import { IsString, MinLength, MaxLength, IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ description: 'Employee code (the identifier, NOT a permission).' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  identifier!: string;

  @ApiProperty({ description: 'Password or PIN value.' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  secret!: string;

  @ApiPropertyOptional({ enum: ['password', 'pin'], description: 'Override the credential mode.' })
  @IsOptional()
  @IsIn(['password', 'pin'])
  mode?: 'password' | 'pin';
}
