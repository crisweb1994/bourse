export interface ChannelTargetInput {
  type?: unknown;
  url?: unknown;
  chatId?: unknown;
}

/** Return a stable, credential-free identifier for delivery logs. */
export function maskChannelTarget(channel: ChannelTargetInput): string {
  if (channel.type === 'TELEGRAM') {
    return `tg:${String(channel.chatId ?? '').slice(-4)}`;
  }

  try {
    return new URL(String(channel.url)).host;
  } catch {
    return 'invalid-url';
  }
}
