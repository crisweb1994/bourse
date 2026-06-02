import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';

/**
 * Wraps `AuthGuard('github')` so that when `AUTH_REQUIRED=false` the
 * GitHub OAuth handshake is bypassed entirely (no redirect to GitHub,
 * no client_id required). The controller handler itself then redirects
 * to `/` for the request entrypoint, or shouldn't be called for the
 * callback (since no redirect to GitHub occurred).
 */
@Injectable()
export class OptionalGithubAuthGuard extends AuthGuard('github')
  implements CanActivate {
  constructor(private authService: AuthService) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (this.authService.isAuthOptional()) {
      // Skip passport entirely — let the handler decide what to do.
      return true;
    }
    return super.canActivate(context);
  }
}
