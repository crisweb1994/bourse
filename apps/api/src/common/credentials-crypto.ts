import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { ChannelConfig } from '@bourse/analysis';

/**
 * 全应用统一的凭证列加密（AES-256-GCM，密文格式 `v1:iv:authTag:ciphertext`，
 * 各段 base64url）。覆盖 AiProviderSetting.apiKeyEncrypted、
 * WebSearchSetting.apiKey 与 DigestSubscription.channels 内的 secret/botToken。
 * 密钥来自 AI_CREDENTIALS_ENCRYPTION_KEY（sha256 派生 32 字节）。
 */

const CIPHER_VERSION = 'v1';
const CIPHER_IV_BYTES = 12;

export function credentialEncryptionKey(config: ConfigService): Buffer {
  const dedicatedSecret = config.get<string>('AI_CREDENTIALS_ENCRYPTION_KEY')?.trim();
  if (!dedicatedSecret) {
    throw new InternalServerErrorException(
      'Credential encryption is not configured; set AI_CREDENTIALS_ENCRYPTION_KEY',
    );
  }
  return createHash('sha256').update(dedicatedSecret, 'utf8').digest();
}

export function encryptCredential(key: Buffer, plain: string): string {
  const iv = randomBytes(CIPHER_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptCredential(key: Buffer, payload: string): string {
  const [version, ivEncoded, authTagEncoded, ciphertextEncoded, ...extra] = payload.split(':');
  if (
    version !== CIPHER_VERSION ||
    !ivEncoded ||
    !authTagEncoded ||
    !ciphertextEncoded ||
    extra.length > 0
  ) {
    throw new InternalServerErrorException(
      'Stored credential has an unsupported or invalid format',
    );
  }

  const iv = Buffer.from(ivEncoded, 'base64url');
  const authTag = Buffer.from(authTagEncoded, 'base64url');
  const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new InternalServerErrorException(
      'Unable to decrypt stored credential; verify AI_CREDENTIALS_ENCRYPTION_KEY',
    );
  }
}

/** 是否已是 `v1:…` 密文形态（用于 channels 字段级加解密的透传判定）。 */
export function isEncryptedCredential(value: string): boolean {
  return /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value);
}

/**
 * 加密 ChannelConfig 内的凭证字段（secret / botToken）。已是密文或空值的字段
 * 原样保留（mergeSecrets 回填的旧值即密文）。仅在确有明文需要加密时才要求
 * 加密密钥存在。
 */
export function encryptChannelSecrets(
  channels: ChannelConfig[],
  config: ConfigService,
): ChannelConfig[] {
  return channels.map((channel) => {
    if ('secret' in channel && channel.secret && !isEncryptedCredential(channel.secret)) {
      const key = credentialEncryptionKey(config);
      return { ...channel, secret: encryptCredential(key, channel.secret) };
    }
    if (channel.type === 'TELEGRAM' && channel.botToken && !isEncryptedCredential(channel.botToken)) {
      const key = credentialEncryptionKey(config);
      return { ...channel, botToken: encryptCredential(key, channel.botToken) };
    }
    return channel;
  });
}

/**
 * 解密 ChannelConfig 内的凭证字段；非密文形态（冒烟脚本手写的明文、旧数据）
 * 原样透传，保证 best-effort 消费方不因历史明文而 500。
 */
export function decryptChannelSecrets(
  channels: ChannelConfig[],
  config: ConfigService,
): ChannelConfig[] {
  return channels.map((channel) => {
    if ('secret' in channel && channel.secret && isEncryptedCredential(channel.secret)) {
      return { ...channel, secret: decryptCredential(credentialEncryptionKey(config), channel.secret) };
    }
    if (channel.type === 'TELEGRAM' && channel.botToken && isEncryptedCredential(channel.botToken)) {
      return { ...channel, botToken: decryptCredential(credentialEncryptionKey(config), channel.botToken) };
    }
    return channel;
  });
}
