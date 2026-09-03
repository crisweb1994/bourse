import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';

interface GithubProfile {
  id: string;
  displayName: string;
  emails?: Array<{ value: string }>;
  photos?: Array<{ value: string }>;
}

/** Session lifetime for BOTH the JWT and the cookies — one source, no drift.
 *  (KISS env review: JWT_EXPIRES_IN only affected the token while three cookie
 *  maxAge sites hardcoded 7d; the knob is gone, the constant is the contract.) */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async findOrCreateUser(profile: GithubProfile) {
    const githubId = profile.id;
    const email = profile.emails?.[0]?.value ?? null;
    const name = profile.displayName || `user-${githubId}`;
    const avatarUrl = profile.photos?.[0]?.value ?? null;

    return this.prisma.user.upsert({
      where: { githubId },
      update: { email, name, avatarUrl },
      create: { githubId, email, name, avatarUrl },
    });
  }

  signJwt(userId: string): string {
    const secret = this.config.getOrThrow<string>('JWT_SECRET');
    return jwt.sign({ sub: userId }, secret, { expiresIn: SESSION_TTL_SECONDS });
  }

  verifyJwt(token: string): { sub: string } | null {
    try {
      const secret = this.config.getOrThrow<string>('JWT_SECRET');
      return jwt.verify(token, secret) as { sub: string };
    } catch {
      return null;
    }
  }

  async findUserById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * Single-tenant / private-deploy mode: when AUTH_REQUIRED=false, the
   * whole app runs as one shared anonymous user. We use a fixed githubId
   * sentinel (`__local__`) so the existing `githubId @unique` constraint
   * keeps working without schema changes. First call upserts; subsequent
   * calls just look up.
   */
  async getOrCreateAnonymousUser() {
    const ANON_GITHUB_ID = '__local__';
    return this.prisma.user.upsert({
      where: { githubId: ANON_GITHUB_ID },
      update: {},
      create: {
        githubId: ANON_GITHUB_ID,
        email: null,
        name: '本地用户',
        avatarUrl: null,
      },
    });
  }

  /** True when AUTH_REQUIRED env is explicitly 'false'. */
  isAuthOptional(): boolean {
    return this.config.get<string>('AUTH_REQUIRED', 'true') === 'false';
  }
}
