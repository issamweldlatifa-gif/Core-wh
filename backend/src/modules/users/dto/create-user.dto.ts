import {
  IsString, IsEmail, IsOptional, MinLength, MaxLength,
  IsArray, IsIn, IsBoolean, ValidateIf, Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ description: 'Full name.' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'Unique employee/access code. Identifies the user, NOT a permission.' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9._-]+$/, { message: 'employeeCode may only contain letters, numbers, ., _ and -' })
  employeeCode!: string;

  @ApiPropertyOptional({ description: 'Email (optional).' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ description: 'Initial password.' })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ description: 'Optional PIN credential (numeric).' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'pin must be numeric (4 to 8 digits)' })
  pin?: string;

  @ApiPropertyOptional({ enum: ['PASSWORD', 'PIN', 'BOTH'] })
  @IsOptional()
  @IsIn(['PASSWORD', 'PIN', 'BOTH'])
  credentialMode?: 'PASSWORD' | 'PIN' | 'BOTH';

  @ApiPropertyOptional({ type: [String], description: 'Role names to assign.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({ description: 'Active immediately?' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
