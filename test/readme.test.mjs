import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT_BASE, PORT_COUNT } from '../src/server-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const README = join(REPO, 'README.ko.md');
const LINE_CAP = 130;
const MIN_SECTIONS = 8; // structure only: section wording is never pinned (the plan forbids prose pins)
const EXTENSION = readFileSync(join(REPO, 'extension.mjs'), 'utf8');
const INSTALL = readFileSync(join(REPO, 'scripts', 'install.mjs'), 'utf8');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}
// Everything the user can see comes from these files.
const SOURCE = [join(REPO, 'extension.mjs'), join(REPO, 'scripts', 'install.mjs'), ...walk(join(REPO, 'src'))]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

// Slash commands registered by extension.mjs, with the sub-words /brief accepts.
const REGISTERED = new Set([...EXTENSION.matchAll(/registerCommand\('([a-z][a-z-]*)'/g)].map((m) => m[1]));
const BRIEF_SUBS = new Set(
  (EXTENSION.match(/registerCommand\('brief',[^)]*?argumentHint: '\[([^\]]+)\]'/s)?.[1] ?? '').split('|'),
);

// Table rows (after header + separator) grouped per table; header's first cell identifies the table.
function tables(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) {
      (cur ??= []).push(line.split('|').slice(1, -1).map((c) => c.trim()));
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.map((rows) => ({ header: rows[0][0], rows: rows.slice(2) }));
}

const REQUIRED_TABLES = [
  ['칩', 7, ['증거 있음', '증거 바뀜', '보고만 됨', '미확인', '후보', '보고 없음', '오래됨']],
  ['표시', 4, ['대기: 작업이 끝나면 전달', '대기: 그 대화가 다시 열리면 전달', '전달 중', '전달됨 ⏱']],
  ['증상', 3, ['적용 안 함', '파일 권한 오류', '대화가 안 보임']],
];

// Returns a list of problems; empty means the document matches the code.

function check(text) {
  const problems = [];
  const lines = text.split('\n');
  if (lines.length > LINE_CAP) problems.push(`lines ${lines.length} > ${LINE_CAP}`);
  if (/[\u2013\u2014]/.test(text)) problems.push('en/em dash');

  // Structure only: at least MIN_SECTIONS numbered sections, numbered 1..N in order. What a
  // section is called is free; no production consumer dispatches on the guide's headings.
  const numbered = lines.map((l) => /^## (\d+)\. /.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  if (numbered.length < MIN_SECTIONS) problems.push(`sections ${numbered.length} < ${MIN_SECTIONS}`);
  else if (numbered.some((n, i) => n !== i + 1)) problems.push(`sections are not numbered 1..${numbered.length}: ${numbered.join(',')}`);

  for (const m of text.matchAll(/(?<![\p{L}\p{N}_:.\/-])\/([a-z][a-z-]*)(?: (on|off|path)\b)?/gu)) {
    if (!REGISTERED.has(m[1])) problems.push(`unregistered command /${m[1]}`);
    else if (m[2] && (m[1] !== 'brief' || !BRIEF_SUBS.has(m[2]))) problems.push(`unknown subcommand /${m[1]} ${m[2]}`);
  }
  for (const m of text.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) {
    if (!INSTALL.includes(`'${m[1]}'`)) problems.push(`unknown flag ${m[1]}`);
  }
  if (!text.includes('--uninstall')) problems.push('missing --uninstall');

  // The doc shows the canonical absolute path; it only has to end with the repo-relative path,
  // so the test passes from any checkout location. The script itself is checked in this checkout.
  const script = text.match(/node (\S+\/scripts\/install\.mjs)/)?.[1];
  if (!script || !/^([A-Za-z]:)?\//.test(script) || !existsSync(join(REPO, 'scripts', 'install.mjs'))) {
    problems.push(`install script path ${script}`);
  }

  // Required tables must exist, with minimum rows and named rows.
  const all = tables(text);
  for (const [header, min, names] of REQUIRED_TABLES) {
    const t = all.find((x) => x.header === header);
    if (!t) {
      problems.push(`missing table ${header}`);
      continue;
    }
    if (t.rows.length < min) problems.push(`table ${header} rows ${t.rows.length} < ${min}`);
    for (const n of names) if (!t.rows.some((r) => r[0].includes(n))) problems.push(`table ${header} missing row ${n}`);
  }

  for (const t of tables(text)) {
    for (const row of t.rows) {
      if (t.header === '칩' || t.header === '표시') {
        for (const s of row[0].split(' / ')) if (!SOURCE.includes(s)) problems.push(`not in code: ${s}`);
      } else {
        for (const m of row[0].matchAll(/`([^`]+)`/g)) {
          const s = m[1].replace(/\s*\.\.\.$/, '');
          if (!SOURCE.includes(s)) problems.push(`not in code: ${s}`);
        }
      }
    }
  }
  for (const s of ['나를 기다림', '진행 중', '끝남', '선택·입력이 끝나면 반영', '표시 뜻', '브리핑 꺼짐:', '브리핑 켜짐:', '반영:', 'omo-briefing.js', 'generations and state kept']) {
    if (text.includes(s) && !SOURCE.includes(s)) problems.push(`not in code: ${s}`);
  }

  // Live-board facts, checked against the code rather than pinned as prose: every port the guide
  // names must be one the board actually serves, and the sound toggle and server record exist.
  const portRange = `${DEFAULT_PORT_BASE}..${DEFAULT_PORT_BASE + PORT_COUNT - 1}`;
  const addrPorts = [...text.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]));
  const fiveDigit = [...text.matchAll(/\b(4\d{4})\b/g)].map((m) => Number(m[1]));
  for (const p of new Set([...addrPorts, ...fiveDigit])) {
    if (p < DEFAULT_PORT_BASE || p > DEFAULT_PORT_BASE + PORT_COUNT - 1) problems.push(`port ${p} outside the board range ${portRange}`);
  }
  if (!addrPorts.includes(DEFAULT_PORT_BASE)) problems.push(`the default board port ${DEFAULT_PORT_BASE} is not named`);

  const LIVE_FACTS = [
    ['🔔', ['🔔']],
    ['🔕', ['🔕']],
    ['server.json', ['server.json']],
  ];
  for (const [shown, code] of LIVE_FACTS) {
    if (!text.includes(shown)) problems.push(`missing live-board fact: ${shown}`);
    else for (const c of code) if (!SOURCE.includes(c)) problems.push(`not in code: ${c}`);
  }
  return problems;
}

const text = readFileSync(README, 'utf8');

test('README.ko.md matches the code (commands, flags, paths, chips, structure, size)', () => {
  assert.deepEqual(check(text), []);
});

test('README.ko.md names every registered command and the uninstall flag', () => {
  for (const name of REGISTERED) assert.ok(text.includes(`/${name}`), `/${name} documented`);
  assert.ok(text.includes('--uninstall'));
  assert.ok(text.includes('/brief off') && text.includes('/brief on'));
});

test('negative: unregistered command, unknown flag, too many lines, and em dash are caught', () => {
  assert.deepEqual(check(text + '\n`/brief-x`\n'), ['unregistered command /brief-x']);
  assert.ok(check(text + '\n--no-such-flag\n').includes('unknown flag --no-such-flag'));
  assert.ok(check(text + '\n'.repeat(LINE_CAP)).some((p) => p.startsWith('lines ')));
  assert.ok(check(text + '\n\u2014\n').includes('en/em dash'));
  assert.ok(check(text.replace('| 증거 있음 |', '| 증거 있슴x |')).some((p) => p.startsWith('not in code')));
});

test('negative: the live address, sound toggle and server record line are enforced', () => {
  const noPorts = text.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:1');
  assert.ok(check(noPorts).includes(`the default board port ${DEFAULT_PORT_BASE} is not named`));
  assert.ok(check(text.replace('47326', '47400')).some((p) => p.startsWith('port 47400 outside')));
  assert.ok(check(text.replace(/🔔/g, '')).includes('missing live-board fact: 🔔'));
  assert.ok(check(text.replace(/🔕/g, '')).includes('missing live-board fact: 🔕'));
  assert.ok(check(text.replace(/server\.json/g, 'records.json')).includes('missing live-board fact: server.json'));
});

test('negative: section wording is free, but the section structure is checked', () => {
  const reworded = text.replace('## 5. 작업자 줄 읽기', '## 5. 작업자들이 무엇을 하는지 보기');
  assert.deepEqual(check(reworded), [], 'a heading synonym must not fail the guide checks');
  assert.ok(check(text.replace(/^## 5\. .*\n/m, '')).some((p) => p.startsWith('sections are not numbered')), 'a dropped section is caught');
  assert.ok(check(text.replace(/^## \d+\. .*\n/gm, '')).includes(`sections 0 < ${MIN_SECTIONS}`), 'a guide with no sections is caught');
});

test('negative: removing tables, rows, or the absolute install path is caught', () => {
  assert.deepEqual(check(text), []);
  const noTables = text.split('\n').filter((l) => !l.startsWith('|')).join('\n');
  const p = check(noTables);
  for (const [h] of REQUIRED_TABLES) assert.ok(p.includes(`missing table ${h}`), `missing table ${h}`);
  const noChips = text.split('\n').filter((l) => !/^\| (칩|증거|보고|미확인|후보|오래됨)/.test(l) && !l.startsWith('| ---')).join('\n');
  assert.ok(check(noChips).includes('missing table 칩'));
  assert.ok(check(text.replace(/^\| 보고 없음 .*\n/m, '')).includes('table 칩 missing row 보고 없음'));
  assert.ok(check(text.replace(/^\| 오래됨 .*\n/m, '')).some((x) => x.startsWith('table 칩 ')));
  assert.ok(check(text.replace(/^\| 전달 중 .*\n/m, '')).includes('table 표시 missing row 전달 중'));
  assert.ok(check(text.replace(/^\| `적용 안 함.*\n/m, '')).includes('table 증상 missing row 적용 안 함'));
  assert.ok(check(text.replace('node C:/', 'node ./scripts/install.mjs #')).some((x) => x.startsWith('install script path')));
});

test('README.ko.md is independent of the checkout location', () => {
  assert.ok(REPO === dirname(HERE));
  assert.deepEqual(check(text.replace('C:/Users/USER/orca/projects/piomo-briefing/scripts', 'D:/elsewhere/repo/scripts')), []);
});
