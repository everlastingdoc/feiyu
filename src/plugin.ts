import type { Context } from '@deepseek-ai/cordis';
import { loadConfig, paths } from './config.js';
import { Store } from './store.js';
import { HarnessConversation } from './harness.js';
import { AssistantService } from './service.js';
import { OfficialTransport } from './transports/official.js';
import { OneBotTransport } from './transports/onebot.js';
import { log } from './util.js';

export const name = 'feiyu-assistant';
export const inject = ['agents', 'agentLoop', 'sessions', 'sessionPersistence', 'compaction'];
export async function apply(ctx: Context): Promise<void> {
  const config = loadConfig();
  const qq = config.qq;
  const transport = qq.transport === 'official'
    ? new OfficialTransport(process.env[qq.official.appIdEnv] ?? '', process.env[qq.official.appSecretEnv] ?? '')
    : new OneBotTransport(qq.onebot.url, process.env[qq.onebot.tokenEnv] ?? '');
  const store = new Store(paths().db);
  const conversation = new HarnessConversation(ctx, store, config);
  const service = new AssistantService(store, config, transport, conversation);
  ctx.effect(() => async () => { try { await service.stop(); } finally { store.close(); } });
  await service.start();
  log('feiyu.started', { transport: qq.transport, provider: config.activeProvider });
}
