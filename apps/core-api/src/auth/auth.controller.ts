import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  AuthResponseDto,
  AuthUserDto,
  ForgotPasswordResultDto,
  ResendVerificationResultDto,
  ResetPasswordResultDto,
  VerifyEmailResultDto,
} from './dto/auth-response.dto';
import { SuccessResultDto } from '../common/dto/operation-result.dto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser, Tokens } from './types';
import { REFRESH_COOKIE, refreshCookieOptions } from './refresh-cookie';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly cookieBase: CookieOptions;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    this.cookieBase = refreshCookieOptions(config);
  }

  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCreatedResponse({ type: AuthResponseDto })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.respondWithTokens(await this.auth.register(dto), res);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: AuthResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.respondWithTokens(await this.auth.login(dto), res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOkResponse({ type: AuthResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const token = this.readRefreshCookie(req);
    if (!token) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return this.respondWithTokens(await this.auth.refresh(token), res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  // Unauthenticated like refresh — it takes the cookie, not a bearer token —
  // and it verifies a JWT and writes to the database on every call. The only
  // route in this controller that was left on the global bucket alone.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOkResponse({ type: SuccessResultDto })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SuccessResultDto> {
    const token = this.readRefreshCookie(req);
    res.clearCookie(REFRESH_COOKIE, this.cookieBase);
    if (!token) {
      return { success: true };
    }
    return this.auth.logout(token);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ type: AuthUserDto })
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: VerifyEmailResultDto })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<VerifyEmailResultDto> {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  // Tighter than the rest of this controller: it is unauthenticated and sends
  // mail, so it is the one route here where a loose bucket costs someone else's
  // inbox rather than only our CPU.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOkResponse({ type: ForgotPasswordResultDto })
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResultDto> {
    return this.auth.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: ResetPasswordResultDto })
  resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<ResetPasswordResultDto> {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOkResponse({ type: ResendVerificationResultDto })
  resendVerification(
    @CurrentUser() user: AuthUser,
  ): Promise<ResendVerificationResultDto> {
    return this.auth.resendVerification(user.userId);
  }

  private respondWithTokens(tokens: Tokens, res: Response): AuthResponseDto {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.cookieBase,
      maxAge: this.auth.refreshTtlMs,
    });
    return { accessToken: tokens.accessToken };
  }

  private readRefreshCookie(req: Request): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
  }
}
