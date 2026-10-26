import { resolve } from 'node:path';
import { writeJson } from './config.js';

/** Configuration schema verified against NapCat v4.18.41; no public listeners. */
export function configureNapcat(directory: string, account: string, onebotToken: string, webuiToken: string): void {
  if (!/^\d{5,12}$/.test(account)) throw new Error('--account 应为机器人登录用的QQ号');
  if (onebotToken.length < 24 || webuiToken.length < 24) throw new Error('OneBot Token与WebUI密码都须至少24字符');
  const onebot = {
    network: { httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [], plugins: [],
      websocketServers: [{ name: 'feiyu-local', enable: true, host: '127.0.0.1', port: 3001, messagePostFormat: 'array', reportSelfMessage: false, token: onebotToken, enableForcePushEvent: true, debug: false, heartInterval: 30000 }] },
    musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false, imageDownloadProxy: '',
  };
  const core = { fileLog: false, consoleLog: false, fileLogLevel: 'error', consoleLogLevel: 'error', autoTimeSync: true };
  writeJson(resolve(directory, 'onebot11.json'), onebot);
  writeJson(resolve(directory, `onebot11_${account}.json`), onebot);
  writeJson(resolve(directory, 'napcat.json'), core);
  writeJson(resolve(directory, `napcat_${account}.json`), core);
  writeJson(resolve(directory, 'webui.json'), { host: '127.0.0.1', port: 6099, token: webuiToken, loginRate: 5, autoLoginAccount: account, disableWebUI: false, enableXForwardedFor: false });
}
