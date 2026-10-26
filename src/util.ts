import { randomUUID } from 'node:crypto';

export function id(): string { return randomUUID().replaceAll('-', '').slice(0, 16); }

export function parseDelay(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error('延迟格式应为 30s、10m、2h 或 3d');
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!;
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result) || result < 1000 || result > 366 * 86_400_000) throw new Error('延迟须在1秒至366天之间');
  return result;
}

export function splitText(text: string, limit = 1500): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const character of text) {
    if (current.length + character.length > limit) { chunks.push(current); current = ''; }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Do not print upstream error bodies, URLs with credentials, prompts, or tokens. */
export function safeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret.length >= 4) message = message.split(secret).join('[REDACTED]');
  return message
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/(api[-_]?key|app[-_]?secret|access[-_]?token|authorization)["'\s:=]+[^\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/sk-[\w-]{8,}/g, '[REDACTED]')
    .slice(0, 300);
}

export function log(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`);
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是JSON对象');
  return value as Record<string, unknown>;
}
