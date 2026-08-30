import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../common/interfaces/request-with-user.interface';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @UseGuards(RateLimitGuard)
  @Post('login')
  @ApiOperation({ summary: 'Login with employee code + password/PIN.' })
  login(@Body() dto: LoginDto, @Req() req: RequestWithUser) {
    return this.auth.login(dto.identifier, dto.secret, dto.mode, {
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
  }

  @Public()
  @UseGuards(RateLimitGuard)
  @Post('refresh')
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair.' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout the current session.' })
  async logout(@CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    await this.auth.logout(user.id, user.sessionId, req.ip);
    return { success: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the current authenticated user with roles & permissions.' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        email: true,
        status: true,
        lastLoginAt: true,
      },
    });
    return { user: dbUser, roles: user.roles, permissions: user.permissions };
  }
}
