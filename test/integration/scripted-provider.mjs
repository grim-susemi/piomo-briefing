// Scripted test provider for the isolated real-host run (plan todo 14). NOT part of `npm test`.
// Registers provider "scripted" / model "scripted-1" through pi.registerProvider (legacy config form with
// `api` + `streamSimple`, DOCS custom-provider.md 'Register New Provider' and 'Registration').
// Behaviour is decided only by the last transcript message, so a run is deterministic:
//   last message is a tool result              -> text "끝"
//   last user text has "[보고 길이]"             -> text "상황판: <SCRIPTED_PAGE_PATH>" (answers the extension's rewrite request)
//   last user text has "BRIEFJSON:{...}"        -> one `brief` tool call with that JSON
//   last user text has "TOOLCALL:<name>:{json}" -> one tool call <name> with that JSON (one line; plan_brief / task scenarios of plan todo 14)
//   last user text has "COUNT3"                 -> text "1\n2\n3\n끝"; after the first delta the run stays streaming until the
//                                               file SCRIPTED_HOLD_FILE exists (event driven, no timed delay)
//   anything else (e.g. the delivered decision) -> text "확인"
// Every call is appended to SCRIPTED_LOG (jsonl) with the tool names the model would have been offered.
import { appendFileSync, existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';

const piAiUrl = process.env.SCRIPTED_PI_AI_URL;
if (!piAiUrl) throw new Error('SCRIPTED_PI_AI_URL is required (file URL of the installed pi-ai index.js)');
const { createAssistantMessageEventStream, getCurrentTools } = await import(piAiUrl);

const HOLD_TIMEOUT_MS = 60000;

/** Resolve once `file` exists (fs.watch on its directory, checked before and after subscribing); reject on abort or timeout. */
function waitForFile(file, signal) {
  return new Promise((resolve, reject) => {
    let watcher = null;
    let timer = null;
    const done = (err) => {
      clearTimeout(timer);
      if (watcher) watcher.close();
      if (signal) signal.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve();
    };
    const onAbort = () => done(new Error('aborted'));
    const check = () => { if (existsSync(file)) done(null); };
    if (signal) signal.addEventListener('abort', onAbort);
    timer = setTimeout(() => done(new Error(`hold file ${file} not released within ${HOLD_TIMEOUT_MS} ms`)), HOLD_TIMEOUT_MS);
    watcher = watch(dirname(file), check);
    check();
  });
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n');
};

function plan(messages) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'toolResult') return { kind: 'text', parts: ['끝'] };
  // The host may append its own reminders (e.g. senpi.todo-first-turn) after the owner's prompt, so read every
  // user-side message since the last assistant message instead of only the final one.
  let from = messages.length;
  while (from > 0 && !(messages[from - 1] && messages[from - 1].role === 'assistant')) from--;
  const text = messages.slice(from).filter((m) => m && m.role === 'user').map((m) => textOf(m.content)).join('\n');
  if (text.includes('[보고 길이]')) return { kind: 'text', parts: [`상황판: ${process.env.SCRIPTED_PAGE_PATH ?? ''}`] };
  const at = text.indexOf('BRIEFJSON:');
  if (at >= 0) return { kind: 'tool', name: 'brief', args: JSON.parse(text.slice(at + 'BRIEFJSON:'.length).split('\n')[0].trim()) };
  const call = /TOOLCALL:([A-Za-z_][\w-]*):(\{.*\})/.exec(text.split('\n').find((l) => l.includes('TOOLCALL:')) ?? '');
  if (call) return { kind: 'tool', name: call[1], args: JSON.parse(call[2]) };
  if (text.includes('COUNT3')) return { kind: 'text', parts: ['1\n', '2\n', '3\n', '끝'], slow: true };
  return { kind: 'text', parts: ['확인'] };
}

function streamScripted(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const output = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'pending', timestamp: Date.now(),
  };
  (async () => {
    try {
      const messages = context.messages ?? [];
      const p = plan(messages);
      if (process.env.SCRIPTED_LOG) {
        const last = messages[messages.length - 1];
        appendFileSync(process.env.SCRIPTED_LOG, `${JSON.stringify({
          at: Date.now(), pid: process.pid, lastRole: last && last.role, plan: p.kind,
          lastText: textOf(last && last.content).slice(0, 160), tools: getCurrentTools(messages).map((t) => t.name),
        })}\n`);
      }
      stream.push({ type: 'start', partial: output });
      if (p.kind === 'tool') {
        output.content.push({ type: 'toolCall', id: `scripted_${Date.now()}`, name: p.name, arguments: {} });
        const i = output.content.length - 1;
        stream.push({ type: 'toolcall_start', contentIndex: i, partial: output });
        output.content[i].arguments = p.args;
        stream.push({ type: 'toolcall_delta', contentIndex: i, delta: JSON.stringify(p.args), partial: output });
        stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: { ...output.content[i] }, partial: output });
        output.stopReason = 'toolUse';
      } else {
        output.content.push({ type: 'text', text: '' });
        const i = 0;
        stream.push({ type: 'text_start', contentIndex: i, partial: output });
        for (const [n, part] of p.parts.entries()) {
          if (options && options.signal && options.signal.aborted) throw new Error('aborted');
          output.content[i].text += part;
          stream.push({ type: 'text_delta', contentIndex: i, delta: part, partial: output });
          // simulates a model that is still generating: stay streaming until the harness releases the run
          if (p.slow && n === 0 && process.env.SCRIPTED_HOLD_FILE) await waitForFile(process.env.SCRIPTED_HOLD_FILE, options && options.signal);
        }
        stream.push({ type: 'text_end', contentIndex: i, content: output.content[i].text, partial: output });
        output.stopReason = 'stop';
      }
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options && options.signal && options.signal.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function (pi) {
  pi.registerProvider('scripted', {
    name: 'Scripted',
    baseUrl: 'http://127.0.0.1:9/',
    apiKey: 'scripted-no-key',
    api: 'scripted-api',
    models: [{
      id: 'scripted-1', name: 'Scripted 1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
    }],
    streamSimple: streamScripted,
  });
}
