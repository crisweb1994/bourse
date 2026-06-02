import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GithubStrategy } from './github.strategy';
import { JwtCookieGuard } from './jwt-cookie.guard';
import { OptionalGithubAuthGuard } from './optional-github.guard';
import { CsrfGuard } from './csrf.guard';

@Module({
  imports: [ConfigModule, PassportModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    GithubStrategy,
    JwtCookieGuard,
    OptionalGithubAuthGuard,
    CsrfGuard,
  ],
  exports: [
    AuthService,
    JwtCookieGuard,
    CsrfGuard,
  ],
})
export class AuthModule {}
