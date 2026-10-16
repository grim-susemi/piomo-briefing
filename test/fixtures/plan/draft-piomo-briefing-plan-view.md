---
slug: piomo-briefing-plan-view
status: approved
intent: clear
review_required: true
plan_path: .omo/plans/piomo-briefing-plan-view.md
plan_sha256: 65c1374c843f1edc4f2d582629c7f5ba3941ea992bba9a47a0547baeecd96078
review_round_id: pv-r3-mv9i31d2
review_round_limit: 5
pending-action: handoff delivered; execution is owner-started via /ulw-execute piomo-briefing-plan-view
review:
  plan_reviewer:
    status: passed
    workspace_root: null
    runtime_home: null
    target: .omo/plans/piomo-briefing-plan-view.md
    round_id: pv-r3-mv9i31d2
    plan_sha256: 65c1374c843f1edc4f2d582629c7f5ba3941ea992bba9a47a0547baeecd96078
    launch_id: pv-r3-mv9i31d2-launch
    session: st_01a13f7d (completed 3m38s)
    result: "OKAY - references valid, 16 todos have entry points and QA, IS-1..IS-11 mapped; no blocking contradictions"
    history: ["pv-r1-mv9ho8ss st_01a13f71 REJECT (IS-11 sync render.lock wait; IS-1 file page bound) -> fixed: renderPageAsync + IS-1 http/file split", "pv-r2-mv9hwafk st_01a13f76 REJECT (todo 13 render-error chip impossible while lock held) -> fixed: meta.errors now, chip on next publish"]
approach: "generation-000004 of omo-briefing: (C1) loopback-only local board server with SSE push owned by one session at a time; (C2) live work feed - workers, per-worker todos, running animation, instant move to 끝남, audible+visual waiting alarm; (C3) plan view via new plan_brief tool + read-only status overlay rendered as wave lanes / task table / Q&A table inside the owning session card; (C4) pickWork senpi: prefix fix; (C5) installer/README/live install gen-4 with file:// fallback kept"
---

# Draft: piomo-briefing-plan-view

## Affected user and ideal state
<!-- Who this output touches (a customer, another programmer, a program or agent consuming it - often more than one) and how each uses it today and will use it after. -->
<!-- IS-n | property of the ideal state: nothing snags, feels odd, regresses, or degrades for them | reason -->
<!-- GAP-n | difference between IS-n and today | reason | closed by todo(s) -->
Users: (U1) the owner - watches one browser board while several OMO conversations and their workers run; today has to click a badge/refresh, cannot see workers' todo progress, reads long prose plans. (U2) lead AI sessions - publish via brief; will also publish plan_brief. (U3) worker/child sessions - must be unaffected (no tools, no slowdown, no file-lock interference).
- IS-1 | A change reaches the open board within ~1s with no click/refresh, tab/scroll/open details kept | owner: "실시간이어야 하는디" / "실시간 스트리밍 느낌"
- IS-2 | Each conversation card shows its live workers (name, model, state, current step) and each worker's todo list, Herdr-dashboard-like | owner: "각 작업자들 투두리스트들 연동되어서 실시간 표기"
- IS-3 | Running items show a small activity animation; finished items/cards move to 끝남 at once with a visible move | owner request
- IS-4 | A new waiting-for-owner question/decision plays a sound and shows a visual alarm; sound can be toggled and never repeats endlessly | owner: "알람 울리고"
- IS-5 | A plan being set up/reviewed/executed shows: goal line, wave lanes with task boxes (from deps), one line per task (what / done criterion), Q&A table, success rows, out-of-scope - readable in under a minute | owner: "아 대충 이런 개념으로 작업이 되겠구나가 보이면"
- IS-6 | Plan question rows reuse the decision path (/decide works now) and carry stable anchors so phase 2 buttons / phase 3 comments need no migration | roadmap
- IS-7 | Stale or missing plan summary is flagged (chip), never shown as more authoritative than the plan file | trust
- IS-8 | Board keeps working if the server is down (file:// page still published) and the server only listens on 127.0.0.1, rejects foreign Host headers, sends no CORS | safety/robustness
- IS-9 | Old-generation sessions can no longer downgrade the served page (server serves its own generation's template) | F3 r3 residual
- IS-10 | Workers and unrelated harness files untouched: no new tools in child sessions, no writes outside briefing/, no fs.watch on project dirs, reads bounded and retried | U3, EPERM history
- GAP-1 (IS-1) page.js POLL_MS=5000 + click-to-apply badge; file:// cannot be pushed -> C1
- GAP-2 (IS-2) collect.mjs reads task records only as worker counts; child todo-state never read (extension.mjs:47,:650 child gate); rpc events not subscribed -> C2
- GAP-3/4 (IS-3,4) no animation, no sound -> C2
- GAP-5/6/7 (IS-5..7) no plan model, no plan_brief, flow[] max 8 labels only -> C3
- GAP-8 (IS-8) no server -> C1/C5
- GAP-9 (IS-9) index.html shared file overwritten by gen-1/2 sessions -> C1
- GAP-10 pickWork session-id prefix bug hides work info -> C4

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
- C1 | local board server: 127.0.0.1 only, single owner via lock+port file, SSE push, serves current-generation page, auto hand-over/shutdown, file:// fallback | active
- C2 | live work feed: workers + per-worker todos + running animation + move-to-끝남 + sound/visual alarm with toggle | active
- C3 | plan view: plan_brief tool, plan store revisions, read-only overlay, lanes/table/Q&A UI, plan questions as decisions, rule v2 | active
- C4 | pickWork senpi: prefix fix | active
- C5 | installer/README/gen-000004 live install + final verification | active

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
- port | fixed default 47317, next free on conflict, written to briefing/server.json; /brief opens http URL | stable bookmark | yes
- server owner | first enabled lead session that needs it; others reuse; owner exit -> next session takes over within ~5s; no detached daemon | no background automation (owner pref) | yes
- security | bind 127.0.0.1, Host header must be 127.0.0.1/localhost:<port>, no CORS headers, GET+SSE only in this phase | DNS-rebinding/other-site reads | yes
- sound | in-page WebAudio beep (no audio file), once per new waiting item, 🔔 toggle in localStorage, first click unlocks audio (browser autoplay rule) | autoplay policy | yes
- worker data | rpc events (omo.task.updated/omo.dag.updated) in-process first; task record + child jsonl tail reads only for non-terminal tasks of this session, ≥2s apart, retry on EBUSY/EPERM, never fs.watch | EPERM history | yes
- animation | CSS only, respects prefers-reduced-motion | readability | yes
- F2 residuals R4-B1..B4 | stay for phase 2 | same code as buttons | yes

## Findings (cited - path:lines)
- Full research saved: .omo/drafts/piomo-briefing-plan-view-research/{explore-repo-planformat,librarian-similar-products,architect-advisory,explore-herdr-sources}.md (all 4 finished 2026-10-15).
- Architect: plan data via NEW `plan_brief` tool (validated, ids = plan todo numbers, planId = p+sha256(root+slug)[:12], anchors `<planId>/<kind>/<id>[/<field>]`, revisions plans/<planId>/rev-N.json wx) + read-only status overlay (checkboxes regex, ledger dispatch/task-completed, draft status, plan/draft sha256) computed in owner/executor session only, no fs.watch, no render-time project reads; skeleton fallback labelled `자동 추출(요약 없음)`; open plan questions become ordinary decision records (allocDecisionId) so /decide works; rule.mjs RULE_TEXT v2 lines; HTML/CSS wave lanes not SVG; plan inside owning session card, no new tab. Do NOT extend `brief` (render reads latest brief only). Existing bug: collect.mjs pickWork compares bare session id vs boulder `senpi:<uuid>` -> auto.work never set (live meta.json 01a13bd0 lacks auto.work).
- Herdr sources: shim -> herdr-dashboard/integration/generation-000007 (todo+dag). Worker list = .omo/senpi-task/tasks/st_*.json (1046 files; dag/src/task-data.mjs) + live pushes via pi.events 'senpi:extension-rpc-event' types omo.task.updated / omo.dag.updated (150ms coalesced; host task-rpc-bridge.ts). Live activity is NOT on disk (live_progress 0/1046); dag/src/stream-tap.mjs taps AgentSession._emit. Per-worker todo lists exist only in children/st_*/sessions/*/*.jsonl `senpi.todo-state` entries; both Herdr (todo/src/child-guard.mjs) and piomo-briefing (extension.mjs:47,:650) refuse child sessions -> new reader needed. Lead todo cache: <agent>/herdr-todo/<ownerKey>/scope-N/todo.cache.json. Waiting-for-owner: briefing mirror/<sid>.json open:true > blocking decisions.
- Librarian: Kiro specs (deps -> waves, line comments as one revision request, plan-mode `1=a` answers), Kiro Crew widgets (button -> agent event), Cline Kanban + Agentation use a local server for interactivity, Orca review notes on rendered markdown tied to source range + batch send, Hypothesis TextQuote {exact,prefix,suffix} 32 chars. Pitfalls: anchors rot (store id+quote+rect), no auto-approve, keep plans glanceable.

## Decisions (with rationale)
- Scope = roadmap phase 1 ("보기 개선: 플랜 시각화") of 3; owner accepted the 3-phase roadmap and "1단계부터" recommendation with "오케바리! 해보자" (2026-10-15). Owner standing preference: big picture -> roadmap -> each phase its own ultraplan (system/human.md PREFERENCE 계획 형태). Phase 1 must lay the data shape phases 2 (button answers) and 3 (anchored comments) reuse.
- Stance: batch, key decisions only (owner 2026-10-14 "간결하게 내가 결정해야할것만 인터뷰해 핵심적인거").
- F2 residuals R4-B1..B4 belong to phase 2 (same code paths), not this plan.
- Owner request 2026-10-15 ("계속 새로고침을 해야 변경된게 보이던데 ... 실시간이어야 하는디"): fold real-time auto-apply into this plan. Today (live gen-3 verified 2026-10-15T10:04Z, stamp 3): src/page/page.js:12 POLL_MS=5000, :189 setInterval inject only when visible, :5/:70 a newer seq only raises the '새 내용 있음' badge, :74 apply() redraws on click. F3 r3 already proved apply() preserves tab, scrollY and open details -> auto-apply is low-risk. Draft default: auto-apply on every newer seq (poll ~2s), keep the badge only while the owner is mid-interaction (text selection / focused input, which phase 3 comments will need), brief flash on changed cards. file:// cannot be pushed; ~2s polling is the real-time bound without a server (server = phase 2).
- Research wave dispatched 2026-10-15: explore (repo + plan format), librarian (similar products), architect advisory (data model/source). Results pending.

## Scope IN
C1-C5 above; tests (TDD) + real Chrome screenshots at 1440x900 and 390x844; live install as generation-000004 at the end; Korean handoff.

## Scope OUT (Must NOT have)
- click-to-answer buttons / any POST endpoint (phase 2); comments, selection capture, drag, comment delivery (phase 3)
- edits to the omo-ai bundle, ulw-plan/ulw-execute skills, Herdr dashboard extension; writes to .omo/plans, .omo/drafts, boulder, ledger, task records
- binding beyond 127.0.0.1, CORS, auth tokens in URLs, detached daemon/service/scheduled task
- fs.watch on project dirs; reading child sessions not belonging to this lead session
- model side-calls to summarize plans; parsing plan prose beyond checkbox/Parallelization/frontmatter status lines
- brief schema change; new sidebar tab; external libraries/CDN; percentages

## Open questions
- Q-STREAM (owner-decision, raised 2026-10-15 "진짜 실시간 스트리밍 느낌나면 좋겠는데"): A = bring the local loopback server (planned for phase 2) into phase 1: SSE push (<1s) + live progress events from the extension (current step, worker/todo changes) + the same server later takes button answers; B = keep file:// with ~1-2s auto-apply poll (near-live, updates only as often as agents write). Process lifecycle/port/localhost-only binding is a cross-cutting choice -> ask in the batch. Leaning A (both streaming feel and phase-2 buttons need it).
  - 2026-10-15 owner add ("헤르드에서 대시보드 현황판 보면 각 작업자들 투두리스트들 연동되어서 실시간 표기 ... 진행 중이면 간단한 애니메이션, 끝난건 바로바로 위치이동하고, 질문 답변 대기중이면 알람 울리고"): new ideal-state rows -> live per-worker todo lists like the Herdr dashboard (reuse its data sources: omo-herdr-dashboard extension, senpi-task records, todo state), running items show a small activity animation, finished cards move to 끝남 immediately (animated move), waiting-for-owner question/decision plays an audible alert + visual alarm. Reply = UNRESOLVED_PROGRESS on Q-STREAM, strengthens A; confirm in batch.

## Approval gate
status: approved (owner "승인 (추천)" 2026-10-15, plan + high-accuracy review)
owner answers 2026-10-15: 범위=둘 다 한 플랜에, 실시간=내 PC 전용 작은 서버, 시험=TDD + 실제 화면 (Q-STREAM resolved A).
plan gate 2026-10-15: plan-consultant spawn refused ("plan-gated ... no such request was made. Do not attempt to unlock this gate yourself"); skill invocation via harness message did not register. Owner chose "내가 한 줄 입력할게" -> wait for owner's standalone `/skill:ulw-plan`, then run plan-consultant + plan-reviewer rounds until OKAY. Plan file is written meanwhile.
next action on approval: rerun scaffold without --draft-only, plan-consultant gap analysis, append todos, TL;DR last, plan-reviewer high-accuracy review.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
