import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { DSH_VERSION, paths, ROOT, writeJson } from './config.js';
import type { AppConfig } from './types.js';

export function profileEntries(config: AppConfig, data = paths().data, pluginPath = resolve(ROOT, 'dist/src/plugin.js')) {
  const providers = Object.fromEntries(Object.entries(config.providers).map(([name, p]) => [name, {
    api: 'openai-completions', baseURL: p.baseUrl, apiKeyEnv: p.apiKeyEnv,
    defaultContextWindow: config.contextWindow, defaultMaxTokens: config.maxOutputTokens,
    retryPolicy: { mode: 'normal', maxRetries: 2 },
    compat: { maxTokensField: p.maxTokensField ?? 'max_tokens', supportsStore: false, ...(p.thinkingFormat ? { thinkingFormat: p.thinkingFormat } : {}) },
    models: [{ id: p.model, name: p.model, contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens, input: ['text'] }],
  }]));
  const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, ...extra });
  return [{ insert: [
    row('timer', '@deepseek-ai/cordis-plugin-timer'),
    row('filesystem', '@deepseek-ai/dsh-fs-local'),
    row('llm', '@deepseek-ai/dsh-llm'),
    row('llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai', { config: { providers } }),
    row('session', '@deepseek-ai/dsh-session'),
    row('session-projection', '@deepseek-ai/dsh-session-projection'),
    row('token-meter', '@deepseek-ai/dsh-token-meter'),
    row('system-prompt', '@deepseek-ai/dsh-system-prompt', { config: { includeHarnessIdentity: true, includeRuntimeContext: false, personaPrefix: config.persona } }),
    row('tools', '@deepseek-ai/dsh-tools'),
    row('agent', '@deepseek-ai/dsh-agent'),
    row('llm-retry', '@deepseek-ai/dsh-llm-retry'),
    row('compaction-basic', '@deepseek-ai/dsh-compaction-basic', { config: { thresholdRatio: 0.8, headroomTokens: 2048, retainTokens: 4096, maxTokens: 4096, auto: true } }),
    row('agent-loop', '@deepseek-ai/dsh-agent-loop', { config: { agents: [], maxParallelToolCalls: 1 } }),
    row('sessions', '@deepseek-ai/dsh-session-persistence-jsonl', { config: { root: resolve(data, 'harness/sessions'), compression: 'none' } }),
    row('feiyu', pluginPath, { required: true }),
  ] }];
}

export function generateProfile(config: AppConfig, data = paths().data, pluginPath?: string): string {
  const dir = resolve(data, 'harness/profiles/feiyu');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(resolve(dir, 'package.json'), { name: 'feiyu-runtime-profile', private: true, dsh: { profile: { bundles: [] } }, feiyuHarnessVersion: DSH_VERSION });
  writeFileSync(resolve(dir, 'cordis.patch.yml'), stringify(profileEntries(config, data, pluginPath)), { mode: 0o600 });
  return dir;
}
