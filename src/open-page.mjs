// omo-briefing src/open-page.mjs - /brief가 상황판을 여는 방법.
// 파일 경로: Chrome이 있으면 execFile(chrome, [file URL]), 없으면 execFile('explorer.exe', [경로]).
// 실시간 주소(http:// 또는 https://): 같은 실행기에 주소를 그대로 넘긴다.
// explorer는 열기에 성공해도 종료코드 1을 돌려주므로 그 코드는 오류로 치지 않는다.
import * as nodeFs from 'node:fs';
import { execFile as nodeExecFile } from 'node:child_process';

export const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WEB_URL_RE = /^https?:\/\//i;

export function fileUrl(pagePath) {
  return `file:///${encodeURI(String(pagePath).replace(/\\/g, '/').replace(/^\/+/, ''))}`;
}

/**
 * 기다리지 않고 띄운다. 비동기로 생기는 오류는 onError로 알린다.
 * @param {string} pagePath index.html 절대경로, 또는 그대로 열 http(s) 주소
 * @param {{platform?: string, exists?: (p:string)=>boolean, execFile?: Function, onError?: (e:Error)=>void}} [opts]
 * @returns {{launcher: 'chrome'|'explorer', command: string, args: string[]}}
 */
export function openPage(pagePath, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? ((p) => nodeFs.existsSync(p));
  const execFile = opts.execFile ?? nodeExecFile;
  const onError = opts.onError ?? (() => {});
  if (platform !== 'win32') {
    throw new Error(`이 플랫폼에서는 자동으로 열지 않습니다. 직접 여세요: ${pagePath}`);
  }
  const useChrome = exists(CHROME_PATH);
  const launcher = useChrome ? 'chrome' : 'explorer';
  const command = useChrome ? CHROME_PATH : 'explorer.exe';
  const isUrl = WEB_URL_RE.test(String(pagePath));
  const args = isUrl ? [String(pagePath)] : useChrome ? [fileUrl(pagePath)] : [String(pagePath).replace(/\//g, '\\')];
  const child = execFile(command, args, (err) => {
    if (!err) return;
    if (launcher === 'explorer' && err.code === 1) return;
    onError(err);
  });
  if (child && typeof child.unref === 'function') child.unref();
  return { launcher, command, args };
}
