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

const DURATION_RE = /^(\d+)\s*(s|m|h|d|w)$/;
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/** Parse a duration string like "7d", "2h", "30m" into seconds. */
function parseDuration(value: string): number {
  const match = value.match(DURATION_RE);
  if (match) {
    return parseInt(match[1], 10) * UNIT_SECONDS[match[2]];
  }
  const asNum = parseInt(value, 10);
  if (!isNaN(asNum)) return asNum;
  return 604800; // default 7 days
}

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
    const expiresIn = parseDuration(
      this.config.get<string>('JWT_EXPIRES_IN', '7d'),
    );
    return jwt.sign({ sub: userId }, secret, { expiresIn });
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
   * RFC rfc-evidence-pack-web-search-fallback: persist the user's opt-in
   * flag. Returns the updated row so callers can reflect it back in the
   * PATCH response.
   */
  async updatePreferences(
    userId: string,
    patch: { allowWebSearchFallback?: boolean },
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(patch.allowWebSearchFallback !== undefined
          ? { allowWebSearchFallback: patch.allowWebSearchFallback }
          : {}),
      },
    });
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
