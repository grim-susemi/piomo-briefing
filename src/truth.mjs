// omo-briefing src/truth.mjs
const LARGE = 10 * 1024 * 1024;
export const STALE_MS = 6 * 3600 * 1000;

export function recheckEvidence(item, env = {}) {
  const { stat = null, sha256 = null } = env;
  if (!item || item.truth !== 'evidence') {
    return { truth: item?.truth ?? 'unverified', evidenceState: 'ok', flag: null };
  }
  if (!stat) return { truth: 'evidence', evidenceState: 'gone', flag: 'evidence_gone' };
  if (stat.size > LARGE) {
    const same = stat.size === item.evidenceSize && (stat.mtimeMs ?? stat.mtime) === (item.evidenceMtimeMs ?? item.evidenceMtime);
    return same
      ? { truth: 'evidence', evidenceState: 'ok', flag: null }
      : { truth: 'evidence', evidenceState: 'changed', flag: 'evidence_changed' };
  }
  const expected = item.evidenceHash ?? item.sha256 ?? null;
  let current = null;
  try { current = typeof sha256 === 'function' ? sha256(item.evidence) : null; } catch {
    // Never trust unreadable evidence: a hash read that throws (ENOENT after
    // stat, EACCES, ...) means the recorded evidence can no longer be shown.
    return { truth: 'evidence', evidenceState: 'gone', flag: 'evidence_gone' };
  }
  if (current == null) {
    // No baseline and nothing to compare: nothing recorded, nothing lost.
    if (expected == null) return { truth: 'evidence', evidenceState: 'ok', flag: null };
    // A recorded baseline we cannot recompute is not evidence any more.
    return { truth: 'evidence', evidenceState: 'gone', flag: 'evidence_gone' };
  }
  return current === expected
    ? { truth: 'evidence', evidenceState: 'ok', flag: null }
    : { truth: 'evidence', evidenceState: 'changed', flag: 'evidence_changed' };
}

function allItems(session = {}) {
  if (Array.isArray(session.items)) return session.items;
  return [...(session.changes ?? []), ...(session.done ?? [])];
}

function openBlocksDecision(session = {}) {
  return (session.decisions ?? []).some((d) => d && d.blocks && !d.answered && !d.closed);
}

function hasEvidenceProblem(session = {}) {
  return allItems(session).some((it) =>
    it && (it.evidenceState === 'changed' || it.evidenceState === 'gone' ||
      it.flag === 'evidence_changed' || it.flag === 'evidence_gone'));
}

export function cardStatus(session, now = Date.now()) {
  void now;
  session = session ?? {};
  const status = session.status ?? 'in_progress';
  if (status === 'blocked') return 'blocked';
  if (openBlocksDecision(session)) return 'needs_decision';
  if (hasEvidenceProblem(session)) return 'recheck';
  if (status === 'done') {
    const done = Array.isArray(session.done) ? session.done : null;
    if (!done || done.length === 0) return 'done_no_evidence';
    if (done.every((d) => d && d.truth === 'unverified')) return 'done_no_evidence';
    return 'done';
  }
  return 'in_progress';
}

export const STATUS_LABEL = {
  blocked: '막힘',
  needs_decision: '결정 대기',
  recheck: '재확인',
  done: '끝남',
  done_no_evidence: '끝(근거 없음)',
  in_progress: '진행 중',
};

export function chips(session, now = Date.now()) {
  session = session ?? {};
  const out = [];
  const meta = session.meta ?? {};
  if (meta.noReport) out.push('보고 없음');
  const status = session.status ?? 'in_progress';
  const last = session.lastActivityAt ?? meta.lastActivityAt ?? null;
  if (status === 'in_progress' && typeof last === 'number' && now - last >= STALE_MS) out.push('오래됨');
  if (meta.readError) out.push('기록 읽기 실패');
  if (meta.mirrorUnavailable) out.push('질문 미러 사용 불가');
  return out;
}

export function tabOf(session, now = Date.now()) {
  void now;
  session = session ?? {};
  const status = session.status ?? 'in_progress';
  const openDecision = (session.decisions ?? []).some((d) => d && !d.answered && !d.closed);
  const mirrorOpen = Boolean(session.mirrorOpen || session.hasOpenQuestion ||
    (Array.isArray(session.questions) && session.questions.some((q) => q && q.open !== false)));
  if (status === 'blocked' || openDecision || mirrorOpen) return '나를 기다림';
  if (status === 'done') return '끝남';
  return '진행 중';
}
