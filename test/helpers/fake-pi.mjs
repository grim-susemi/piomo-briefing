// Scripted fake pi host for extension tests: records registrations and drives events like the real runner
// (handlers run in registration order; boundary handlers see the chained entries/continue/context).
export function makeFakePi({ sessionKind = 'interactive', cwd = 'C:/work/proj' } = {}) {
  const handlers = new Map();
  const tools = [];
  const commands = new Map();
  const registrations = { on: [], tools: [], commands: [] };
  const pi = {
    sessionKind,
    cwd,
    sessionContext: {},
    on(event, handler, options) {
      registrations.on.push(event);
      const list = handlers.get(event) ?? [];
      list.push({ handler, options });
      handlers.set(event, list);
      return () => {};
    },
    registerTool(tool) { tools.push(tool); registrations.tools.push(tool.name); },
    registerCommand(name, options) { commands.set(name, options); registrations.commands.push(name); },
    getSessionName() { return undefined; },
  };

  async function emit(type, payload, ctx) {
    const out = [];
    for (const { handler } of handlers.get(type) ?? []) {
      const r = await handler({ type, ...payload }, ctx);
      if (r !== undefined) out.push(r);
    }
    return out;
  }

  /** agent_before_settle / turn_end style chained boundary. */
  async function boundary(type, base, ctx, contextMessages) {
    let entries = [];
    let shouldContinue = false;
    for (const { handler } of handlers.get(type) ?? []) {
      const r = await handler({ type, ...base, entries, continue: shouldContinue, context: { contextMessages } }, ctx);
      if (r && r.entries !== undefined) entries = r.entries;
      if (r && r.continue !== undefined) shouldContinue = r.continue;
    }
    return { entries, continue: shouldContinue };
  }

  /**
   * What the real SENPI runner does at the end of a run (SENPI = @code-yeongyu/senpi/dist/core):
   * agent-session.js:2417-2425 runs the agent_before_settle boundary and, when a handler asked for it, schedules a
   * continuation; pi-agent-core agent-loop.js:71 (runAgentLoopContinue) then emits a NEW agent_start before the
   * continued response; only when no continuation is launched does agent-session.js:2426-2428 emit agent_settled
   * (_emitAgentSettled -> runner emit at agent-session.js:1705). The extension therefore sees
   * agent_start -> ... -> agent_before_settle -> agent_start -> ... -> agent_before_settle -> agent_settled.
   */
  async function settle(base, ctx, contextMessages) {
    const result = await boundary('agent_before_settle', base, ctx, contextMessages);
    const next = result.continue ? 'agent_start' : 'agent_settled';
    await emit(next, {}, ctx);
    return { ...result, next };
  }

  const tool = (name) => tools.find((t) => t.name === name);
  return { pi, handlers, tools, commands, registrations, emit, boundary, settle, tool };
}

export function makeCtx({ cwd = 'C:/work/proj', sid = 'sess-A', file = 'C:/sessions/sess-A.jsonl', hasUI = true, branch = [] } = {}) {
  const notes = [];
  const ctx = {
    hasUI,
    cwd,
    mode: 'rpc',
    ui: { notify: (text, level) => notes.push({ text, level }) },
    sessionManager: {
      getSessionId: () => sid,
      getSessionFile: () => file,
      getBranch: () => branch,
    },
    isIdle: () => true,
  };
  return { ctx, notes };
}

export const assistant = (text, extra = []) => ({ role: 'assistant', content: [...(text === null ? [] : [{ type: 'text', text }]), ...extra] });
export const toolCall = { type: 'toolCall', id: 't1', name: 'bash', arguments: {} };
export const lines = (n, label = '줄') => Array.from({ length: n }, (_, i) => `${label}${i}`).join('\n');
