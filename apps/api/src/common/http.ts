export interface JsonPostOptions {
  /** Add the shared HMAC header when the destination uses a webhook secret. */
  hmacSecret?: string;
}

/** Shared JSON transport for all notification channels. */
export async function postJson(
  url: string,
  payload: unknown,
  options: JsonPostOptions = {},
): Promise<number> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.hmacSecret !== undefined) {
    headers['X-Bourse-Signature'] = `sha256=${await hmacSha256Hex(options.hmacSecret, body)}`;
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  return response.status;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  return Buffer.from(new Uint8Array(signature)).toString('hex');
}
