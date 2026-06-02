import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/callback'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // The API may live on a different subdomain and own a host-only auth cookie.
  // In that setup this middleware cannot see the token, but browser requests to
  // the API can still be authenticated with credentials: 'include'.
  const token = request.cookies.get('sc_token')?.value;
  if (!token) {
    return NextResponse.next();
  }

  // If a frontend-visible token exists, reject obviously malformed values early.
  if (token.split('.').length !== 3) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Check JWT expiration client-side (without secret verification)
  // Full verification happens server-side via /api/auth/me
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      const loginUrl = new URL('/login', request.url);
      const response = NextResponse.redirect(loginUrl);
      response.cookies.delete('sc_token');
      return response;
    }
  } catch {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
