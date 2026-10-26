export type Channel = 'official' | 'onebot';

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  thinkingFormat?: 'deepseek' | 'openai';
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
}

export interface AppConfig {
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
  timezone: 'Asia/Shanghai';
  persona: string;
  contextWindow: number;
  maxOutputTokens: number;
  idleMinutes: number;
  rotateAfterTurns: number;
  requestTimeoutSeconds: number;
  qq: {
    transport: Channel;
    official: { appIdEnv: string; appSecretEnv: string };
    onebot: { url: string; tokenEnv: string };
  };
}

export interface InboundMessage {
  channel: Channel;
  kind: 'private' | 'group';
  senderId: string;
  messageId: string;
  text: string;
  receivedAt: number;
  replyId?: string;
}

export interface SendReceipt {
  messageIds: string[];
  /** Acceptance by an API is deliberately distinct from human confirmation. */
  acceptedAt: number;
}

export interface Transport {
  readonly channel: Channel;
  readonly connected: boolean;
  start(onMessage: (message: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(target: string, text: string, options?: { replyId?: string }): Promise<SendReceipt>;
}

export class DeliveryError extends Error {
  constructor(message: string, public readonly outcome: 'retry' | 'failed' | 'unknown', public readonly code?: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export interface Memory {
  id: string;
  content: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
export interface Notification {
  id: string;
  idempotencyKey: string;
  channel: Channel;
  recipient: string;
  text: string;
  dueAt: number;
  nextAttemptAt: number;
  createdAt: number;
  attempts: number;
  status: NotificationStatus;
  error: string | null;
  receipt: string | null;
  confirmedAt: number | null;
}

export interface InboxItem extends InboundMessage {
  id: string;
  status: string;
}

export interface ConversationState {
  sessionId: string;
  turns: number;
  carry: string;
  /** Makes a crash between a successful turn and inbox acknowledgement recoverable. */
  lastInboundId?: string;
  lastResponse?: string;
}

export interface Conversation {
  chat(text: string, inboundId: string): Promise<string>;
  reset(): Promise<void>;
  compact(): Promise<string>;
  release(): Promise<void>;
  status(): { sessionId: string; turns: number; active: boolean };
}
