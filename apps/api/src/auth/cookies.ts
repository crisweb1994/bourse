import { Response } from 'express';

const COOKIE_PATH = '/';

export function clearCookieVariants(
  response: Pick<Response, 'clearCookie'>,
  name: string,
  cookieDomain?: string,
) {
  if (cookieDomain) {
    response.clearCookie(name, { path: COOKIE_PATH, domain: cookieDomain });
  }

  response.clearCookie(name, { path: COOKIE_PATH });
}

export function clearAuthCookieVariants(
  response: Pick<Response, 'clearCookie'>,
  cookieDomain?: string,
) {
  clearCookieVariants(response, 'sc_token', cookieDomain);
  clearCookieVariants(response, 'sc_csrf', cookieDomain);
}
