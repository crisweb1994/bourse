import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

// Legacy compat only: rows created before plaintext storage kept their key
// in `apiKeyEncrypted`. New writes use the plaintext `apiKey` column, so we
// only ever need to DECRYPT old rows — there is no live encrypt path.
export function decryptSecret(value: string, secret: string): string {
  const [ivText, tagText, encryptedText] = value.split('.');
  if (!ivText || !tagText || !encryptedText) {
    throw new Error('Invalid encrypted secret');
  }

  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
