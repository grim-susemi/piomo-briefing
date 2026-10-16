// omo-briefing src/waiting.mjs - store snapshot -> what is waiting for the owner's answer, with a stable identity.
//
// waitingItems(snapshot) -> [{key, sessionId, title, text, blocks, at}]   pure: no I/O, no clock, the input is not touched.
//   snapshot = store.readSnapshot(). The key is the alarm identity (plan Scope '알람'); the page remembers the keys it has
//   seen, so one thing never rings twice:
//   - open decision                         d<id>
//   - open decision of a plan question      p<planId>:<qid>     source 'plan' (planId already starts with 'p', so a key
//                                                               reads pp1a2b3c4d5e6:Q1). When another session takes the
//                                                               plan over, the re-created decision keeps this key.
//   - open ask-user question (mirror)       q<sid>:<requestId>  one item per request: mirror requests[] while open !== false
//   - that question after it closed         q<sid>:<requestId>  mirror unconverted[] (its decision card is still owed) and
//     without an answer                                         the source 'question-timeout' decisions it became
//   Older mirror records without requests[]/unconverted[] (an open question only): q<sid>:<at>.
// An open decision has no answer record and no closure record: the board's own rule (render.mjs answered/closed).
// Records sharing a key are one item: blocks = any of them, at = the earliest, text = the first (the mirror question,
// then the decision with the lowest id). Only sessions in snapshot.sessions count; title = the latest brief's title, then
// meta.title, then the session id (as render.mjs). Order: at ascending (unknown last), then key. Text is flattened to one
// line; clipping is the page's job (src/page/alarm.js).

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const line = (v) => str(v).replace(/\s+/g, ' ').trim();

function titleOf(entry) {
  const latest = arr(entry.briefs).at(-1);
  const data = isObj(latest) ? latest.data : null;
  const brief = isObj(data) ? (isObj(data.brief) ? data.brief : data) : {};
  const meta = isObj(entry.meta) ? entry.meta : {};
  return str(brief.title) || str(meta.title) || entry.sid;
}

function idSet(list) {
  const ids = new Set();
  for (const r of arr(list)) if (isObj(r) && Number.isInteger(r.id)) ids.add(r.id);
  return ids;
}

function firstQuestion(request) {
  for (const q of arr(request.questions)) {
    const text = isObj(q) ? line(q.question) || line(q.header) : '';
    if (text) return text;
  }
  return '';
}

function decisionKey(d) {
  if (d.source === 'plan' && str(d.planId) && str(d.qid)) return `p${d.planId}:${d.qid}`;
  if (d.source === 'question-timeout' && str(d.requestId)) return `q${d.sessionId}:${d.requestId}`;
  return `d${d.id}`;
}

/** @param {object} snapshot store.readSnapshot() */
export function waitingItems(snapshot) {
  const snap = isObj(snapshot) ? snapshot : {};
  const titles = new Map();
  for (const entry of arr(snap.sessions)) {
    if (isObj(entry) && typeof entry.sid === 'string' && entry.sid !== '') titles.set(entry.sid, titleOf(entry));
  }
  const byKey = new Map();
  const add = (key, sessionId, text, blocks, at) => {
    if (!titles.has(sessionId)) return;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { key, sessionId, title: titles.get(sessionId), text, blocks, at });
      return;
    }
    cur.blocks = cur.blocks || blocks;
    if (at !== null && (cur.at === null || at < cur.at)) cur.at = at;
    if (!cur.text && text) cur.text = text;
  };

  // The mirror first: it holds the question as it was asked.
  for (const m of arr(snap.mirror)) {
    if (!isObj(m) || typeof m.sid !== 'string' || !isObj(m.data)) continue;
    const { sid, data } = m;
    const fileAt = isNum(data.at) ? data.at : null;
    const fromRequest = (r) => {
      if (!isObj(r) || typeof r.requestId !== 'string' || r.requestId === '') return;
      add(`q${sid}:${r.requestId}`, sid, firstQuestion(r) || line(data.question), r.required === true, isNum(r.at) ? r.at : fileAt);
    };
    if (Array.isArray(data.requests) || Array.isArray(data.unconverted)) {
      if (data.open !== false) arr(data.requests).forEach(fromRequest);
      arr(data.unconverted).forEach(fromRequest); // closed unanswered, card still owed: waiting all the same
    } else if (data.open !== false) {
      const text = line(data.question) || line(data.text);
      if (text) add(`q${sid}:${fileAt ?? 'open'}`, sid, text, false, fileAt);
    }
  }

  const answered = idSet(snap.answers);
  const closed = idSet(snap.closures);
  const decisions = arr(snap.decisions)
    .filter((d) => isObj(d) && Number.isInteger(d.id) && typeof d.sessionId === 'string')
    .sort((a, b) => a.id - b.id);
  for (const d of decisions) {
    if (answered.has(d.id) || closed.has(d.id)) continue;
    add(decisionKey(d), d.sessionId, line(d.question), d.blocks === true, isNum(d.createdAt) ? d.createdAt : null);
  }

  const atOf = (i) => (i.at === null ? Infinity : i.at);
  return [...byKey.values()].sort((a, b) => (atOf(a) - atOf(b)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
