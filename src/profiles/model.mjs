// Ported to JS from C:/Users/USER/Desktop/OpenCode_Modes/OMO_Native_Profile_Switcher.ps1
// (ProfileMeta :229-310, RoleInventory/RoutingGroups ~:350, model alias and provider labels
// :360-580, subscription visible-model lists :527-551, BuiltinModelProfiles :790-807) and from
// OMO_Native_ReasoningLevels.psm1 (thinking maps). Pure data and pure helpers: no DOM, no file I/O.
// The 5.1.38 refresh layer lives in refresh-5.1.38.mjs so parity tests exercise this layer alone.

export const PROFILE_META = [
  {
    key: 'gpt-kimi-deepseek', num: 1,
    name: 'GPT + Kimi + DeepSeek', nameKr: 'GPT + Kimi + 딥시크',
    tag: 'GPT 구독 최적화', omoProfile: 'native-gpt-kimi-deepseek',
    mainProvider: 'kimi-coding', mainModel: 'k3', mainThinking: 'max',
    summary: 'Kimi가 세션을 조율하고, GPT가 깊은 구현·검토를, 딥시크가 탐색·단순 작업을 맡습니다.',
    fallbackChains: { 'kimi-coding/k3': ['ollama/glm-5.3-flash', 'ollama/glm-5.3', 'ollama/glm-5.2'] },
  },
  {
    key: 'gpt-deepseek', num: 2,
    name: 'GPT + DeepSeek', nameKr: 'GPT + 딥시크',
    tag: '딥시크 Flash 메인', omoProfile: 'native-gpt-deepseek',
    mainProvider: 'opencode-go', mainModel: 'deepseek-v4-flash', mainThinking: 'max',
    summary: '딥시크 Flash가 세션을 이끌고, GPT가 오라클·비판·심층 등 깊은 작업을 맡습니다.',
    fallbackChains: null,
  },
  {
    key: 'kimi-deepseek', num: 3,
    name: 'Kimi + DeepSeek', nameKr: 'Kimi + 딥시크',
    tag: 'GPT 구독 없이 사용', omoProfile: 'native-kimi-deepseek',
    mainProvider: 'kimi-coding', mainModel: 'k3', mainThinking: 'max',
    summary: 'GPT 없이 Kimi가 조율·검증·고강도 추론을 맡고, 딥시크 플래시가 구현·탐색·빠른 작업을 처리합니다.',
    fallbackChains: { 'kimi-coding/k3': ['ollama/glm-5.3-flash', 'ollama/glm-5.3', 'ollama/glm-5.2'] },
  },
  {
    key: 'kimi-ollama-deepseek', num: 4,
    name: 'GLM + DeepSeek (Ollama)', nameKr: 'GLM + 딥시크 (올라마)',
    tag: 'Kimi 할당량 백업', omoProfile: 'native-kimi-ollama-deepseek',
    mainProvider: 'ollama', mainModel: 'glm-5.3-flash', mainThinking: 'max',
    summary: 'Kimi 구독 할당량이 떨어졌을 때 올라마 구독의 GLM 5.3 Flash가 조율·검증을, 딥시크 플래시가 빠른 작업을 맡는 백업 배치입니다. (GLM 5.3/5.2 순 폴백)',
    fallbackChains: { 'kimi-coding/k3': ['ollama/glm-5.3-flash', 'ollama/glm-5.3', 'ollama/glm-5.2'] },
  },
  {
    key: 'experimental-custom', num: 5,
    name: 'Experimental Custom', nameKr: '실험용 자유 설정',
    tag: '내가 직접 조합하는 프로필', omoProfile: 'native-experimental-custom',
    mainProvider: 'ollama', mainModel: 'glm-5.3-flash', mainThinking: 'max',
    summary: '구독 서비스, AI 모델, 추론 강도를 직접 바꾸며 자유롭게 실험하는 개인용 프로필입니다. (기본 GLM 5.3 Flash)',
    fallbackChains: null,
  },
  {
    key: 'cmd-glm-deepseek', num: 6,
    name: 'GLM + DeepSeek (CommandCode)', nameKr: 'GLM + 딥시크 (커맨드코드)',
    tag: '커맨드코드 max 추론', omoProfile: 'native-cmd-glm-deepseek',
    mainProvider: 'commandcode', mainModel: 'z-ai/glm-5.3-flash', mainThinking: 'max',
    summary: '커맨드코드 구독의 GLM 5.3 Flash(max 추론)가 조율·검증을 맡고, 딥시크 플래시가 빠른 작업을 처리합니다. 올라마는 high가 한계라 진짜 max 추론이 필요할 때 쓰는 경로입니다.',
    fallbackChains: null,
  },
];

export function getProfile(key) {
  return PROFILE_META.find((profile) => profile.key === key) ?? null;
}

// Native built-in roles are display defaults, never persisted during load.
export const BUILTIN_ROLE_CATEGORIES = {
  'omo-native-code-reviewer': ['unspecified-high'],
  'omo-native-gate-reviewer': ['deep-high', 'unspecified-high'],
  'omo-native-qa-executor': ['deep-low', 'unspecified-low'],
};

export const ROLE_DISPLAY_NAMES = {
  'omo-native-code-reviewer': { Ko: '코드 리뷰', En: 'omo-native-code-reviewer' },
  'omo-native-gate-reviewer': { Ko: '게이트 리뷰', En: 'omo-native-gate-reviewer' },
  'omo-native-qa-executor': { Ko: '수동 QA 실행', En: 'omo-native-qa-executor' },
  explore: { Ko: '탐색', En: 'Explore' },
  librarian: { Ko: '자료 조사', En: 'Librarian' },
  'plan-consultant': { Ko: '중재·통합', En: 'metis (plan-consultant)' },
  ouroboros: { Ko: '우로보로스 기획', En: 'Ouroboros' },
  oracle: { Ko: '오라클', En: 'Oracle' },
  'plan-reviewer': { Ko: '비판·검증', En: 'momus (plan-reviewer)' },
  quick: { Ko: '빠른 처리', En: 'Quick' },
  'fast-explore': { Ko: '빠른 탐색', En: 'Fast Explore' },
  'unspecified-low': { Ko: '일반 작업(저강도)', En: 'Unspecified low' },
  'unspecified-high': { Ko: '일반 작업(고강도)', En: 'Unspecified high' },
  'visual-engineering': { Ko: '시각 엔지니어링', En: 'Visual Engineering' },
  artistry: { Ko: '예술·디자인', En: 'Artistry' },
  architect: { Ko: '아키텍처', En: 'Architect' },
  'deep-low': { Ko: '심층 추론(저)', En: 'Deep low' },
  'deep-high': { Ko: '심층 추론(고)', En: 'Deep high' },
  ultrabrain: { Ko: '초고난도', En: 'Ultrabrain' },
  writing: { Ko: '글쓰기', En: 'Writing' },
};

// Section-qualified identity inventory. Display names are never routing keys.
export const ROLE_INVENTORY = {
  agents: ['explore', 'librarian', 'plan-consultant', 'ouroboros', 'oracle', 'plan-reviewer',
    'omo-native-code-reviewer', 'omo-native-gate-reviewer', 'omo-native-qa-executor'],
  categories: ['fast-explore', 'quick', 'unspecified-low', 'unspecified-high', 'deep-low',
    'deep-high', 'ultrabrain', 'architect', 'visual-engineering', 'artistry', 'writing'],
};

// Display-only purpose groups; never used to resolve or persist a route.
export const ROUTING_GROUPS = {
  agents: {
    label: '전담 에이전트 · Agents',
    groups: {
      discovery: { label: '탐색 · 자료 조사', roles: ['explore', 'librarian'] },
      planning: { label: '계획 · 조언', roles: ['plan-consultant', 'ouroboros', 'oracle'] },
      review: { label: '검토 · QA', roles: ['plan-reviewer', 'omo-native-code-reviewer',
        'omo-native-gate-reviewer', 'omo-native-qa-executor'] },
    },
  },
  categories: {
    label: '작업 카테고리 · Categories',
    groups: {
      general: { label: '빠른 작업 · 일반 작업', roles: ['fast-explore', 'quick',
        'unspecified-low', 'unspecified-high'] },
      reasoning: { label: '심층 추론', roles: ['deep-low', 'deep-high', 'ultrabrain'] },
      specialism: { label: '전문 작업', roles: ['architect', 'visual-engineering',
        'artistry', 'writing'] },
    },
  },
};

export const MODEL_ALIAS_LABELS = {
  "fable": {
    "En": "Fable 5",
    "Ko": "페이블 5"
  },
  "kimi": {
    "En": "Kimi K3",
    "Ko": "Kimi K3"
  },
  "kimi-max": {
    "En": "Kimi K3",
    "Ko": "Kimi K3"
  },
  "kimi-low": {
    "En": "Kimi K3",
    "Ko": "Kimi K3"
  },
  "kimi-fast": {
    "En": "Kimi K3 Fast",
    "Ko": "Kimi K3 고속"
  },
  "sol": {
    "En": "GPT-5.6 Sol",
    "Ko": "GPT-5.6 솔"
  },
  "sol-max": {
    "En": "GPT-5.6 Sol",
    "Ko": "GPT-5.6 솔"
  },
  "sol-high": {
    "En": "GPT-5.6 Sol",
    "Ko": "GPT-5.6 솔"
  },
  "sol-medium": {
    "En": "GPT-5.6 Sol",
    "Ko": "GPT-5.6 솔"
  },
  "sol-6": {
    "En": "GPT-6 Sol",
    "Ko": "GPT-6 솔"
  },
  "sol-6-max": {
    "En": "GPT-6 Sol",
    "Ko": "GPT-6 솔"
  },
  "sol-6-high": {
    "En": "GPT-6 Sol",
    "Ko": "GPT-6 솔"
  },
  "sol-6-medium": {
    "En": "GPT-6 Sol",
    "Ko": "GPT-6 솔"
  },
  "sol-6-off": {
    "En": "GPT-6 Sol",
    "Ko": "GPT-6 솔"
  },
  "sol-61": {
    "En": "GPT-6.1 Sol",
    "Ko": "GPT-6.1 솔"
  },
  "sol-61-fast": {
    "En": "GPT-6.1 Sol Fast",
    "Ko": "GPT-6.1 솔 고속"
  },
  "astra": {
    "En": "GPT-6 Astra",
    "Ko": "GPT-6 아스트라"
  },
  "astra-max": {
    "En": "GPT-6 Astra",
    "Ko": "GPT-6 아스트라"
  },
  "astra-high": {
    "En": "GPT-6 Astra",
    "Ko": "GPT-6 아스트라"
  },
  "terra": {
    "En": "GPT-5.6 Terra",
    "Ko": "GPT-5.6 테라"
  },
  "terra-medium": {
    "En": "GPT-5.6 Terra",
    "Ko": "GPT-5.6 테라"
  },
  "terra-xhigh": {
    "En": "GPT-5.6 Terra",
    "Ko": "GPT-5.6 테라"
  },
  "luna-xhigh": {
    "En": "GPT-5.6 Luna",
    "Ko": "GPT-5.6 루나"
  },
  "luna-fast": {
    "En": "GPT-5.6 Luna Fast",
    "Ko": "GPT-5.6 루나 고속"
  },
  "luna-6-xhigh": {
    "En": "GPT-6 Luna",
    "Ko": "GPT-6 루나"
  },
  "luna-6-low": {
    "En": "GPT-6 Luna",
    "Ko": "GPT-6 루나"
  },
  "luna-6-off": {
    "En": "GPT-6 Luna",
    "Ko": "GPT-6 루나"
  },
  "flash": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "flash-max": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "flash-low": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "flash-high": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "pro": {
    "En": "DeepSeek V4 Pro",
    "Ko": "딥시크 V4 프로"
  },
  "glm-high": {
    "En": "GLM 5.2",
    "Ko": "GLM 5.2"
  },
  "glm-max": {
    "En": "GLM 5.2",
    "Ko": "GLM 5.2"
  },
  "glm-ollama": {
    "En": "GLM 5.2",
    "Ko": "GLM 5.2"
  },
  "glm-ollama-max": {
    "En": "GLM 5.2",
    "Ko": "GLM 5.2"
  },
  "glm-ollama-low": {
    "En": "GLM 5.2",
    "Ko": "GLM 5.2"
  },
  "flash-ollama": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "flash-ollama-high": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "flash-ollama-4-1": {
    "En": "DeepSeek V4.1 Flash",
    "Ko": "딥시크 V4.1 플래시"
  },
  "cmd-flash": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "cmd-pro": {
    "En": "DeepSeek V4 Pro",
    "Ko": "딥시크 V4 프로"
  },
  "cmd-deepseek-4-1-flash": {
    "En": "DeepSeek V4.1 Flash",
    "Ko": "딥시크 V4.1 플래시"
  },
  "cmd-sol": {
    "En": "GPT-5.6 Sol",
    "Ko": "GPT-5.6 솔"
  },
  "cmd-terra": {
    "En": "GPT-5.6 Terra",
    "Ko": "GPT-5.6 테라"
  },
  "cmd-luna": {
    "En": "GPT-5.6 Luna",
    "Ko": "GPT-5.6 루나"
  },
  "cmd-sol-6": {
    "En": "GPT-6 Sol",
    "Ko": "GPT-6 솔"
  },
  "cmd-luna-6": {
    "En": "GPT-6 Luna",
    "Ko": "GPT-6 루나"
  },
  "cmd-kimi": {
    "En": "Kimi K3",
    "Ko": "Kimi K3"
  },
  "cmd-glm": {
    "En": "GLM 5.2",
    "Ko": "GLM 5.2"
  },
  "glm-5-3": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "glm-5-3-high": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "glm-5-3-max": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "glm-5-3-off": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "glm-5-3-flash": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "glm-5-3-flash-high": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "glm-5-3-flash-max": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "glm-5-3-flash-off": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "cmd-glm-5-3": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "cmd-glm-5-3-flash": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "cmd-zai-org-glm-5-3": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "cmd-zai-org-glm-5-3-high": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "cmd-zai-org-glm-5-3-medium": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "cmd-zai-org-glm-5-3-off": {
    "En": "GLM 5.3",
    "Ko": "GLM 5.3"
  },
  "cmd-z-ai-glm-5-3-flash": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "cmd-z-ai-glm-5-3-flash-medium": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "cmd-z-ai-glm-5-3-flash-off": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "cmd-glm-5-3-flash-max": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "cmd-qwen": {
    "En": "Qwen 3.7 Max",
    "Ko": "Qwen 3.7 Max"
  },
  "cmd-minimax": {
    "En": "MiniMax M3",
    "Ko": "MiniMax M3"
  },
  "cmd-gemini": {
    "En": "Gemini 3.6 Flash",
    "Ko": "Gemini 3.6 플래시"
  },
  "cmd-grok": {
    "En": "Grok 4.6",
    "Ko": "Grok 4.6"
  },
  "cmd-claude": {
    "En": "Claude Sonnet 5",
    "Ko": "Claude Sonnet 5"
  },
  "cmd-fable": {
    "En": "Claude Fable 5",
    "Ko": "Claude Fable 5"
  },
  "cmd-fable-5-1": {
    "En": "Claude Fable 5.1",
    "Ko": "Claude Fable 5.1"
  },
  "cmd-opus": {
    "En": "Claude Opus 5",
    "Ko": "Claude Opus 5"
  },
  "cmd-haiku": {
    "En": "Claude Haiku 4.5",
    "Ko": "Claude Haiku 4.5"
  },
  "zen-big-pickle": {
    "En": "Big Pickle",
    "Ko": "Big Pickle"
  },
  "zen-deepseek-flash-free": {
    "En": "DeepSeek V4 Flash Free",
    "Ko": "딥시크 V4 플래시 무료"
  },
  "zen-mimo-free": {
    "En": "MiMo-V2.5 Free",
    "Ko": "MiMo-V2.5 무료"
  },
  "zen-hy3-free": {
    "En": "Hy3 Free",
    "Ko": "Hy3 무료"
  },
  "zen-laguna-free": {
    "En": "Laguna S 2.1 Free",
    "Ko": "Laguna S 2.1 무료"
  },
  "zen-nemotron-ultra-free": {
    "En": "Nemotron 3 Ultra Free",
    "Ko": "Nemotron 3 Ultra 무료"
  },
  "zen-nemotron-lightning-free": {
    "En": "Nemotron 3.5 Lightning Free",
    "Ko": "Nemotron 3.5 Lightning 무료"
  },
  "commandcode/stealth/space-bunny-alpha": {
    "En": "Space Bunny Alpha Free",
    "Ko": "Space Bunny Alpha 무료"
  },
  "commandcode/stealth/pixel-canary": {
    "En": "Pixel Canary Free",
    "Ko": "Pixel Canary 무료"
  },
  "commandcode/poolside/laguna-s-2.1-free": {
    "En": "Laguna S 2.1 Free",
    "Ko": "Laguna S 2.1 무료"
  },
  "cmd-laguna-free-low": {
    "En": "Laguna S 2.1 Free",
    "Ko": "Laguna S 2.1 무료"
  },
  "orcarouter/z-ai/glm-5.3-flash": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "orcarouter/z-ai/glm-5.3-flash-free": {
    "En": "GLM 5.3 Flash Free",
    "Ko": "GLM 5.3 플래시 무료"
  },
  "orcarouter/deepseek/deepseek-v4-flash": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "orcarouter/deepseek/deepseek-v4-flash-free": {
    "En": "DeepSeek V4 Flash Free",
    "Ko": "딥시크 V4 플래시 무료"
  },
  "orcarouter/free": {
    "En": "Orca Router Free (auto)",
    "Ko": "오르카 무료 (자동 라우팅)"
  },
  "orcarouter/auto": {
    "En": "Orca Router Auto",
    "Ko": "오르카 자동 라우팅"
  },
  "orcarouter/orcarouter/free": {
    "En": "Orca Router Free (auto)",
    "Ko": "오르카 무료 (자동 라우팅)"
  },
  "orcarouter/orcarouter/auto": {
    "En": "Orca Router Auto",
    "Ko": "오르카 자동 라우팅"
  },
  "orca-glm-5-3-flash": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "orca-glm-5-3-flash-free": {
    "En": "GLM 5.3 Flash Free",
    "Ko": "GLM 5.3 플래시 무료"
  },
  "orca-deepseek-v4-flash": {
    "En": "DeepSeek V4 Flash",
    "Ko": "딥시크 V4 플래시"
  },
  "orca-deepseek-v4-flash-free": {
    "En": "DeepSeek V4 Flash Free",
    "Ko": "딥시크 V4 플래시 무료"
  },
  "orca-free": {
    "En": "Orca Router Free (auto)",
    "Ko": "오르카 무료 (자동 라우팅)"
  },
  "routeway/deepseek-v4-flash:free": {
    "En": "DeepSeek V4 Flash Free",
    "Ko": "딥시크 V4 플래시 무료"
  },
  "routeway/deepseek-v4.1-flash": {
    "En": "DeepSeek V4.1 Flash",
    "Ko": "딥시크 V4.1 플래시"
  },
  "routeway/glm-5.3-flash": {
    "En": "GLM 5.3 Flash",
    "Ko": "GLM 5.3 플래시"
  },
  "routeway/glm-5.3-flash-uncensored": {
    "En": "GLM 5.3 Flash Uncensored",
    "Ko": "GLM 5.3 플래시 언센서드"
  },
  "ollama-local/leonardoba500/deepseek-v41-uncensored": {
    "En": "DeepSeek V4.1 Uncensored",
    "Ko": "딥시크 V4.1 언센서드"
  },
  "ds41-uncensored": {
    "En": "DeepSeek V4.1 Uncensored",
    "Ko": "딥시크 V4.1 언센서드"
  },
  "explabs-luna": {
    "En": "GPT-5.6 Luna (ExpLabs)",
    "Ko": "GPT-5.6 루나 (ExpLabs)"
  },
  "explabs-grok": {
    "En": "Grok 4.7 (ExpLabs)",
    "Ko": "그록 4.7 (ExpLabs)"
  },
  "explabs-nemotron": {
    "En": "Nemotron 3 Ultra (ExpLabs)",
    "Ko": "네모트론 3 울트라 (ExpLabs)"
  },
  "explabs-ds4-flash": {
    "En": "DeepSeek V4 Flash (ExpLabs)",
    "Ko": "딥시크 V4 플래시 (ExpLabs)"
  },
  "explabs-ds41-flash": {
    "En": "DeepSeek V4.1 Flash (ExpLabs)",
    "Ko": "딥시크 V4.1 플래시 (ExpLabs)"
  },
  "explabs-jev": {
    "En": "Jev (Decision)",
    "Ko": "제브 (결정 모델)"
  },
  "anthropic-subscription/claude-fable-5-1": {
    "En": "Claude Fable 5.1",
    "Ko": "Claude Fable 5.1"
  },
  "anthropic-subscription/claude-fable-5": {
    "En": "Claude Fable 5",
    "Ko": "Claude Fable 5"
  },
  "anthropic-subscription/claude-opus-5-5": {
    "En": "Claude Opus 5.5",
    "Ko": "Claude Opus 5.5"
  },
  "anthropic-subscription/claude-opus-5": {
    "En": "Claude Opus 5",
    "Ko": "Claude Opus 5"
  },
  "anthropic-subscription/claude-opus-4-8": {
    "En": "Claude Opus 4.8",
    "Ko": "Claude Opus 4.8"
  },
  "anthropic-subscription/claude-opus-4-7": {
    "En": "Claude Opus 4.7",
    "Ko": "Claude Opus 4.7"
  },
  "anthropic-subscription/claude-opus-4-6": {
    "En": "Claude Opus 4.6",
    "Ko": "Claude Opus 4.6"
  },
  "anthropic-subscription/claude-opus-4-5": {
    "En": "Claude Opus 4.5",
    "Ko": "Claude Opus 4.5"
  },
  "anthropic-subscription/claude-sonnet-5-5": {
    "En": "Claude Sonnet 5.5",
    "Ko": "Claude Sonnet 5.5"
  },
  "anthropic-subscription/claude-sonnet-5": {
    "En": "Claude Sonnet 5",
    "Ko": "Claude Sonnet 5"
  },
  "anthropic-subscription/claude-sonnet-4-6": {
    "En": "Claude Sonnet 4.6",
    "Ko": "Claude Sonnet 4.6"
  },
  "anthropic-subscription/claude-sonnet-4-5": {
    "En": "Claude Sonnet 4.5",
    "Ko": "Claude Sonnet 4.5"
  },
  "anthropic-subscription/claude-haiku-5-5": {
    "En": "Claude Haiku 5.5",
    "Ko": "Claude Haiku 5.5"
  },
  "anthropic-subscription/claude-haiku-4-5": {
    "En": "Claude Haiku 4.5",
    "Ko": "Claude Haiku 4.5"
  },
  "opencode/gemini-4-argon": {
    "En": "Argon (Gemini 4)",
    "Ko": "Argon (Gemini 4)"
  }
};

export const PROVIDER_LABELS = {
  "opencode-go": {
    "En": "OpenCode-Go",
    "Ko": "오픈코드Go 구독"
  },
  "ollama": {
    "En": "Ollama Cloud",
    "Ko": "올라마 클라우드"
  },
  "ollama-local": {
    "En": "Ollama Local",
    "Ko": "올라마 로컬"
  },
  "kimi-coding": {
    "En": "Kimi Coding",
    "Ko": "Kimi 구독"
  },
  "opencode": {
    "En": "OpenCode",
    "Ko": "OpenCode"
  },
  "openai-codex": {
    "En": "OpenAI Codex",
    "Ko": "OpenAI Codex"
  },
  "openai": {
    "En": "OpenAI",
    "Ko": "OpenAI"
  },
  "zai-coding-plan": {
    "En": "ZAI GLM",
    "Ko": "ZAI GLM 구독"
  },
  "cursor-gjc": {
    "En": "Cursor GJC",
    "Ko": "Cursor 게이트웨이"
  },
  "sakana": {
    "En": "Sakana",
    "Ko": "Sakana"
  },
  "commandcode": {
    "En": "Command Code",
    "Ko": "커맨드코드 구독"
  },
  "commandcode-anthropic": {
    "En": "Command Code Claude",
    "Ko": "커맨드코드 구독"
  },
  "commandcode-subscription": {
    "En": "커맨드코드 구독",
    "Ko": "커맨드코드 구독"
  },
  "chatgpt-subscription": {
    "En": "ChatGPT subscription",
    "Ko": "ChatGPT 구독"
  },
  "anthropic-subscription": {
    "En": "Claude subscription",
    "Ko": "Claude 구독"
  },
  "opencode-zen-free": {
    "En": "OpenCode Zen 무료",
    "Ko": "OpenCode Zen 무료"
  },
  "orcarouter": {
    "En": "Orca Router",
    "Ko": "Orca Router"
  },
  "routeway": {
    "En": "Routeway",
    "Ko": "Routeway"
  },
  "explabs": {
    "En": "Experiential Labs",
    "Ko": "Experiential Labs"
  }
};

export const COMMANDCODE_PROVIDER_CHOICE = 'commandcode-subscription';
export const CHATGPT_SUBSCRIPTION_PROVIDER_CHOICE = 'chatgpt-subscription';
export const ANTHROPIC_SUBSCRIPTION_PROVIDER_CHOICE = 'anthropic-subscription';
export const ZEN_FREE_PROVIDER_CHOICE = 'opencode-zen-free';
export const CHATGPT_SUBSCRIPTION_MODEL_IDS = [
  'chatgpt-subscription/gpt-6-astra',
  'chatgpt-subscription/gpt-6-sol',
  'chatgpt-subscription/gpt-6.1-sol',
  'chatgpt-subscription/gpt-6-luna',
];
export const ANTHROPIC_SUBSCRIPTION_MODEL_IDS = [
  'anthropic-subscription/claude-fable-5-1',
  'anthropic-subscription/claude-fable-5',
  'anthropic-subscription/claude-opus-5-5',
  'anthropic-subscription/claude-opus-5',
  'anthropic-subscription/claude-opus-4-8',
  'anthropic-subscription/claude-opus-4-7',
  'anthropic-subscription/claude-opus-4-6',
  'anthropic-subscription/claude-opus-4-5',
  'anthropic-subscription/claude-sonnet-5-5',
  'anthropic-subscription/claude-sonnet-5',
  'anthropic-subscription/claude-sonnet-4-6',
  'anthropic-subscription/claude-sonnet-4-5',
  'anthropic-subscription/claude-haiku-5-5',
  'anthropic-subscription/claude-haiku-4-5',
];
export const ZEN_FREE_MODEL_IDS = [
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/mimo-v2.5-free',
  'opencode/hy3-free',
  'opencode/laguna-s-2.1-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
];
export const PROVIDER_GROUPING_OVERRIDES = {
  'ollama-local/leonardoba500/deepseek-v41-uncensored': 'ollama',
};
export const ENGINE_SURFACED_MODELS = { opencode: ['gemini-4-argon'] };

export const OMO_BETA_LABEL = '5.1.33';

// Display builtin chains without writing them over user model_profiles.
export const BUILTIN_MODEL_PROFILES = {
  'daily-normal': [
    { providers: ['anthropic-subscription', 'anthropic', 'anthropic-api', 'github-copilot', 'opencode'], model: 'claude-opus-5-5', variant: 'medium' },
    { providers: ['kimi-coding', 'kimi-for-coding', 'moonshotai', 'opencode-go'], model: 'kimi-k3', variant: 'max' },
    { providers: ['zai', 'zai-coding-cn', 'opencode-go'], model: 'glm-5.3', variant: 'max' },
  ],
  'daily-heavy': [
    { providers: ['anthropic-subscription', 'anthropic', 'anthropic-api', 'github-copilot', 'opencode'], model: 'claude-fable-5-1', variant: 'xhigh' },
  ],
  'geeky-normal': [
    { providers: ['chatgpt-subscription', 'openai'], model: 'gpt-6.1-sol-fast', variant: 'medium' },
    { providers: ['chatgpt-subscription', 'openai'], model: 'gpt-6.1-sol', variant: 'medium' },
    { providers: ['chatgpt-subscription', 'openai', 'github-copilot', 'opencode'], model: 'gpt-5.6-sol', variant: 'medium' },
  ],
  'geeky-heavy': [
    { providers: ['chatgpt-subscription', 'openai', 'github-copilot', 'opencode'], model: 'gpt-6-astra', variant: 'high' },
  ],
};

export const MODEL_FAMILY_COLORS = {
  GPT: { Bg: '#EEF2FF', Fg: '#3730A3' },
  Kimi: { Bg: '#FFF1F2', Fg: '#BE123C' },
  DeepSeek: { Bg: '#F0F9FF', Fg: '#075985' },
  GLM: { Bg: '#ECFDF5', Fg: '#065F46' },
  Fable: { Bg: '#F5F3FF', Fg: '#5B21B6' },
  기타: { Bg: '#F4F4F5', Fg: '#3F3F46' },
};

export const VARIANT_LABELS = {
  low: { En: 'low', Ko: '낮음' },
  medium: { En: 'medium', Ko: '중간' },
  high: { En: 'high', Ko: '높음' },
  max: { En: 'max', Ko: '최대' },
  xhigh: { En: 'xhigh', Ko: '최고' },
};

export const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const BUILTIN_THINKING_MAPS = {
  "commandcode/meta/muse-spark-1.3": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "commandcode/deepseek/deepseek-v4.1-flash": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "commandcode/meta/muse-spark-1.3-contributor": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "commandcode/z-ai/glm-5.3-flash": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "commandcode/zai-org/GLM-5.3": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "commandcode/stealth/pixel-canary": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "commandcode/stealth/space-bunny-alpha": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "orcarouter/z-ai/glm-5.3-flash": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "orcarouter/z-ai/glm-5.3-flash-free": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "orcarouter/deepseek/deepseek-v4-flash": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "orcarouter/deepseek/deepseek-v4-flash-free": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "kimi-coding/k3": {
    "api": "anthropic-messages",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "kimi-coding/k3-256k": {
    "api": "anthropic-messages",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "openai-codex/gpt-5.3-codex-spark": {
    "api": "openai-codex-responses",
    "map": {
      "xhigh": "xhigh",
      "minimal": "low"
    }
  },
  "openai-codex/gpt-5.4": {
    "api": "openai-codex-responses",
    "map": {
      "xhigh": "xhigh",
      "minimal": "low"
    }
  },
  "openai-codex/gpt-5.4-mini": {
    "api": "openai-codex-responses",
    "map": {
      "xhigh": "xhigh",
      "minimal": "low"
    }
  },
  "openai-codex/gpt-5.5": {
    "api": "openai-codex-responses",
    "map": {
      "xhigh": "xhigh",
      "minimal": "low"
    }
  },
  "openai-codex/gpt-5.6-luna": {
    "api": "openai-codex-responses",
    "map": {
      "xhigh": "xhigh",
      "max": "max",
      "minimal": "low"
    }
  },
  "openai-codex/gpt-6-luna": {
    "api": "openai-codex-responses",
    "map": {
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "openai-codex/gpt-5.6-sol": {
    "api": "openai-codex-responses",
    "map": {
      "xhigh": "xhigh",
      "max": "max",
      "minimal": "low"
    }
  },
  "openai-codex/gpt-6-sol": {
    "api": "openai-codex-responses",
    "map": {
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "openai-codex/gpt-6.1-sol": {
    "api": "openai-codex-responses",
    "map": {
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "openai-codex/gpt-5.6-terra": {
    "api": "openai-codex-responses",
    "map": {
      "xhigh": "xhigh",
      "max": "max",
      "minimal": "low"
    }
  },
  "openai-codex/gpt-6-astra": {
    "api": "openai-codex-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "chatgpt-subscription/gpt-6-astra": {
    "api": "openai-codex-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "chatgpt-subscription/gpt-6-sol": {
    "api": "openai-codex-responses",
    "map": {
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "chatgpt-subscription/gpt-6.1-sol": {
    "api": "openai-codex-responses",
    "map": {
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "chatgpt-subscription/gpt-6-luna": {
    "api": "openai-codex-responses",
    "map": {
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode-go/deepseek-v4-flash": {
    "api": "openai-completions",
    "map": {
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "max": "max"
    }
  },
  "opencode-go/deepseek-v4-pro": {
    "api": "openai-completions",
    "map": {
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "max": "max"
    }
  },
  "opencode-go/glm-5.2": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "opencode-go/gpt-5.6-luna": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode-go/grok-4.5": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode-go/hy3": {
    "api": "openai-completions",
    "map": {
      "off": "none",
      "minimal": null,
      "low": "low",
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode-go/kimi-k2.6": {
    "api": "openai-completions",
    "map": {
      "minimal": null,
      "low": null,
      "medium": null
    }
  },
  "opencode-go/kimi-k3": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": null,
      "xhigh": null,
      "max": "max"
    }
  },
  "opencode-go/muse-spark-1.2-contributor": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode-go/muse-spark-1.3-contributor": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/claude-fable-5": {
    "api": "anthropic-messages",
    "map": {
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "commandcode-anthropic/claude-fable-5-1": {
    "api": "anthropic-messages",
    "map": {
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/claude-opus-4-6": {
    "api": "anthropic-messages",
    "map": {
      "max": "max"
    }
  },
  "opencode/claude-opus-4-7": {
    "api": "anthropic-messages",
    "map": {
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/claude-opus-4-8": {
    "api": "anthropic-messages",
    "map": {
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/claude-opus-5": {
    "api": "anthropic-messages",
    "map": {
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/claude-sonnet-4-6": {
    "api": "anthropic-messages",
    "map": {
      "max": "max"
    }
  },
  "opencode/claude-sonnet-5": {
    "api": "anthropic-messages",
    "map": {
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-fable-5": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-fable-5-1": {
    "api": "anthropic-messages",
    "map": {
      "off": null,
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-haiku-4-5": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "anthropic-subscription/claude-haiku-4-5-20251001": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "anthropic-subscription/claude-haiku-5-5": {
    "api": "anthropic-messages",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-opus-4-5": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "anthropic-subscription/claude-opus-4-5-20251101": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "anthropic-subscription/claude-opus-4-6": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "anthropic-subscription/claude-opus-4-7": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-opus-4-8": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-opus-5": {
    "api": "anthropic-messages",
    "map": {
      "off": null,
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-opus-5-5": {
    "api": "anthropic-messages",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-sonnet-4-5": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "anthropic-subscription/claude-sonnet-4-5-20250929": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "anthropic-subscription/claude-sonnet-4-6": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "anthropic-subscription/claude-sonnet-5": {
    "api": "anthropic-messages",
    "map": {
      "off": "off",
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "anthropic-subscription/claude-sonnet-5-5": {
    "api": "anthropic-messages",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/deepseek-v4-flash": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "opencode/deepseek-v4-flash-free": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "opencode/deepseek-v4-pro": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "opencode/gemini-3-flash": {
    "api": "google-generative-ai",
    "map": {
      "off": null
    }
  },
  "opencode/gemini-3.1-pro": {
    "api": "google-generative-ai",
    "map": {
      "off": null,
      "minimal": null,
      "low": "LOW",
      "medium": null,
      "high": "HIGH"
    }
  },
  "opencode/gemini-4-argon": {
    "api": "google-generative-ai",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/gemini-3.5-flash": {
    "api": "google-generative-ai",
    "map": {
      "off": null
    }
  },
  "opencode/gemini-3.5-flash-lite": {
    "api": "google-generative-ai",
    "map": {
      "off": null
    }
  },
  "opencode/gemini-3.6-flash": {
    "api": "google-generative-ai",
    "map": {
      "off": null
    }
  },
  "opencode/glm-5.2": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "opencode/gpt-5": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/gpt-5-codex": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/gpt-5-nano": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/gpt-5.1": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/gpt-5.1-codex": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/gpt-5.1-codex-max": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.1-codex-mini": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/gpt-5.2": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.2-codex": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.3-codex": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.4": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.4-mini": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.4-nano": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.4-pro": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.5": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.5-pro": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": null
    }
  },
  "opencode/gpt-5.6-luna": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/gpt-5.6-sol": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/gpt-5.6-terra": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "opencode/grok-4.5": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/grok-build-0.1": {
    "api": "openai-responses",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null
    }
  },
  "opencode/hy3-free": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "opencode/kimi-k3": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": null,
      "xhigh": null,
      "max": "max"
    }
  },
  "opencode/laguna-s-2.1-free": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": null
    }
  },
  "routeway/deepseek-v4.1-flash": {
    "api": "openai-completions",
    "map": {
      "minimal": "high",
      "low": "high",
      "medium": "high",
      "high": "high",
      "max": "max"
    }
  },
  "routeway/glm-5.3-flash": {
    "api": "openai-completions",
    "map": {
      "max": "max"
    }
  },
  "routeway/glm-5.3-flash-uncensored": {
    "api": "openai-completions",
    "map": {
      "max": "max"
    }
  },
  "routeway/deepseek-v4-flash:free": {
    "api": "openai-completions",
    "map": {
      "minimal": "high",
      "low": "high",
      "medium": "high",
      "high": "high",
      "xhigh": "max",
      "max": "max"
    }
  },
  "ollama-local/leonardoba500/deepseek-v41-uncensored": {
    "api": "openai-completions",
    "map": {
      "off": "none",
      "minimal": null,
      "low": "low",
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "ollama/glm-5.3": {
    "api": "openai-completions",
    "map": {
      "off": "none",
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "ollama/glm-5.3-flash": {
    "api": "openai-completions",
    "map": {
      "off": "none",
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "explabs/gpt-5.6-luna": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "explabs/grok-4.7": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "explabs/nemotron-3-ultra-550b-a55b": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    }
  },
  "explabs/deepseek-v4-flash": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  },
  "explabs/deepseek-v4.1-flash": {
    "api": "openai-completions",
    "map": {
      "off": null,
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "xhigh": null,
      "max": "max"
    }
  }
};
export const OLLAMA_THINKING_LEVEL_MAP = {
  "off": "none",
  "minimal": null,
  "low": "low",
  "medium": "medium",
  "high": "high",
  "xhigh": null,
  "max": "high"
};
export const MAX_MODEL_IDS = [
  "opus-4-6",
  "opus-4.6",
  "opus-4-7",
  "opus-4.7",
  "opus-4-8",
  "opus-4.8",
  "opus-5",
  "sonnet-5",
  "fable-5",
  "fable-5-1"
];
export const XHIGH_MODEL_IDS = [
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6.1-sol",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "opus-4-6",
  "opus-4.6",
  "opus-4-7",
  "opus-4.7",
  "opus-4-8",
  "opus-4.8",
  "opus-5",
  "sonnet-5",
  "fable-5",
  "fable-5-1"
];
export const OPENAI_MAX_APIS = [
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "openai-completions"
];

export function getBuiltinProfileNoteText(profiles = BUILTIN_MODEL_PROFILES, betaLabel = OMO_BETA_LABEL) {
  const chains = Object.keys(profiles).map((id) => {
    const rungs = profiles[id].map((rung) => `${rung.model}/${rung.variant ?? '기본'}`);
    return `${id} = ${rungs.join(' + ')}`;
  });
  const names = Object.keys(profiles).join(' / ');
  return `${betaLabel} model_profile: ${names}. ${chains.join(', ')}. 체인 순서와 추론 강도는 ${betaLabel} 내장값입니다. 실제 사용 가능 모델은 새 세션의 레지스트리에서 결정됩니다. custom-literal은 provider/model을 고정하고 off는 기존 메인 기본값을 사용합니다.`;
}

export function getModelFamily(modelLabel) {
  if (typeof modelLabel !== 'string') return '기타';
  if (modelLabel.startsWith('GPT')) return 'GPT';
  if (modelLabel.startsWith('Kimi')) return 'Kimi';
  if (modelLabel.startsWith('DeepSeek') || modelLabel.startsWith('딥시크')) return 'DeepSeek';
  if (modelLabel.startsWith('GLM')) return 'GLM';
  if (modelLabel.startsWith('Fable')) return 'Fable';
  return '기타';
}

export function formatVariantDisplay(variant) {
  if (typeof variant !== 'string' || variant.trim() === '') return '';
  const entry = VARIANT_LABELS[variant.toLowerCase()];
  return entry ? entry.En : variant.toLowerCase();
}

export function formatModelDisplay(catalog, modelKey) {
  const entry = catalog?.[modelKey];
  if (!entry || !entry.model) return `[unknown:${modelKey}]`;
  const label = MODEL_ALIAS_LABELS[modelKey] ?? { En: modelKey, Ko: modelKey };
  return label.En;
}

export function formatModelDisplayKr(catalog, modelKey) {
  const entry = catalog?.[modelKey];
  if (!entry || !entry.model) return `[unknown:${modelKey}]`;
  const label = MODEL_ALIAS_LABELS[modelKey] ?? { En: modelKey, Ko: modelKey };
  return label.Ko;
}

export function getProviderFromModelId(modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') return '';
  return modelId.split('/')[0];
}

export function getProviderChoiceForModel(modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') return '';
  if (Object.hasOwn(PROVIDER_GROUPING_OVERRIDES, modelId)) return PROVIDER_GROUPING_OVERRIDES[modelId];
  if (ZEN_FREE_MODEL_IDS.includes(modelId)) return ZEN_FREE_PROVIDER_CHOICE;
  const provider = getProviderFromModelId(modelId);
  if (provider === 'commandcode' || provider === 'commandcode-anthropic') return COMMANDCODE_PROVIDER_CHOICE;
  return provider;
}

export function getFullModelId(provider, model) {
  if (model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) return model;
  return `${provider}/${model}`;
}

// Storage projection: strip only the real provider prefix (display grouping never applies).
export function getModelIdWithoutProvider(modelId) {
  return modelId.split('/').slice(1).join('/');
}

export function formatProviderDisplay(provider) {
  if (typeof provider !== 'string' || provider.trim() === '') return '';
  return PROVIDER_LABELS[provider]?.En ?? provider;
}

export function formatProviderDisplayKr(provider) {
  if (typeof provider !== 'string' || provider.trim() === '') return '';
  return PROVIDER_LABELS[provider]?.Ko ?? provider;
}

export function getMemoryReasoning(entry) {
  if (!entry || typeof entry !== 'object') return '';
  for (const field of ['reasoning', 'reasoningEffort', 'variant']) {
    const value = entry[field];
    if (typeof value === 'string' && value) {
      const level = value.trim().toLowerCase();
      return level === 'none' ? 'off' : level;
    }
  }
  return '';
}

const LEGACY_AGENT_ALIASES = { metis: 'plan-consultant', momus: 'plan-reviewer' };

export function canonicalAgentRole(role) {
  return LEGACY_AGENT_ALIASES[role] ?? role;
}

// Explicit normalizers only; the ordinary read/save path never renames reviewer keys.
export function syncAgentAliases(layer) {
  if (!layer || typeof layer !== 'object') return layer;
  for (const section of ['agents', 'categories']) {
    const rows = layer[section];
    if (!rows || typeof rows !== 'object') continue;
    for (const [role, target] of Object.entries(LEGACY_AGENT_ALIASES)) {
      if (!Object.hasOwn(rows, role)) continue;
      if (!Object.hasOwn(rows, target)) rows[target] = rows[role];
      delete rows[role];
    }
  }
  return layer;
}

// Port of Expand-SenpiLayerRoles: never materialize an inherited reviewer assignment in the copy.
export function expandLayerRoles({ catalog, layer }) {
  const source = structuredClone(layer ?? {});
  syncAgentAliases(source);
  const roles = [];
  for (const section of ['agents', 'categories']) {
    const entries = source[section] ?? null;
    const names = [...ROLE_INVENTORY[section]];
    if (entries && typeof entries === 'object') {
      for (const name of Object.keys(entries)) if (!names.includes(name)) names.push(name);
    }
    for (const name of names) {
      const entry = entries?.[name];
      const alias = typeof entry?.model === 'string' ? entry.model : '';
      const catalogEntry = alias && catalog ? catalog[alias] : null;
      const unresolved = Boolean(alias) && !(catalogEntry && typeof catalogEntry.model === 'string' && catalogEntry.model.trim());
      let effectiveAlias = '';
      let effectiveCategory = '';
      if (section === 'agents' && BUILTIN_ROLE_CATEGORIES[name] && !alias) {
        for (const category of BUILTIN_ROLE_CATEGORIES[name]) {
          const candidateAlias = source.categories?.[category]?.model ?? '';
          if (!candidateAlias) continue;
          const resolved = catalog?.[candidateAlias];
          if (!resolved?.model) continue;
          effectiveAlias = candidateAlias;
          effectiveCategory = category;
          break;
        }
      }
      const modelId = !unresolved && catalogEntry ? catalogEntry.model : '';
      const variant = catalogEntry ? getMemoryReasoning(catalogEntry) : '';
      const provider = modelId ? getProviderChoiceForModel(modelId) : '';
      const variantEntry = VARIANT_LABELS[variant];
      roles.push({
        Section: section, Role: name, CanonicalRoleId: name, Inherited: false,
        EffectiveAlias: effectiveAlias, EffectiveCategory: effectiveCategory,
        Unresolved: unresolved, ModelKey: alias, ModelId: modelId,
        ModelEn: unresolved ? `[unknown:${alias}]` : (modelId ? formatModelDisplay(catalog, alias) : ''),
        ModelKo: unresolved ? `[unknown:${alias}]` : (modelId ? formatModelDisplayKr(catalog, alias) : ''),
        Variant: variant, VariantEn: formatVariantDisplay(variant),
        VariantKo: variantEntry ? variantEntry.Ko : '',
        Provider: provider,
        ProviderEn: provider ? formatProviderDisplay(provider) : '',
        ProviderKo: provider ? formatProviderDisplayKr(provider) : '',
      });
    }
  }
  return roles;
}

export function getConfigRoles(config, omoProfile) {
  const layer = config.profiles?.[omoProfile]?.['[senpi]'] ?? config.profiles?.[omoProfile]?.['[native]'];
  if (!layer) throw new Error(`OMO profile '${omoProfile}' has no engine layer`);
  const catalog = config['[senpi]']?.models ?? config['[native]']?.models;
  return expandLayerRoles({ catalog, layer });
}

// Route row used by the recommendation guide (Port of New-RouteRow's display part).
export function newRouteRow(row) {
  const variantEn = row.VariantEn ?? '';
  const variantKo = row.VariantKo ?? '';
  const badgeEn = variantEn ? `${row.ProviderEn} · ${row.ModelEn} / ${variantEn}` : `${row.ProviderEn} · ${row.ModelEn}`;
  const badgeKr = variantKo ? `${row.ProviderKo} · ${row.ModelKo} / ${variantKo}` : `${row.ProviderKo} · ${row.ModelKo}`;
  const family = getModelFamily(row.ModelEn);
  const colors = MODEL_FAMILY_COLORS[family] ?? MODEL_FAMILY_COLORS['기타'];
  return { ...row, BadgeEn: badgeEn, BadgeKr: badgeKr, Family: family, Fg: colors.Fg, Bg: colors.Bg };
}

// Purpose-ordered rows. Unknown layer rows are kept at the end of their section under "extras".
export function buildRoutingRows({ inventory = ROLE_INVENTORY, layer = null } = {}) {
  const rows = [];
  for (const section of ['agents', 'categories']) {
    const purpose = ROUTING_GROUPS[section];
    const known = new Set(inventory[section] ?? []);
    const layerRows = layer?.[section] && typeof layer[section] === 'object' ? Object.keys(layer[section]) : [];
    for (const [groupId, group] of Object.entries(purpose.groups)) {
      for (const role of group.roles) {
        if (!known.has(role)) continue;
        rows.push({ section, role, group: groupId, groupLabel: group.label,
          labelKo: ROLE_DISPLAY_NAMES[role]?.Ko ?? role, labelEn: ROLE_DISPLAY_NAMES[role]?.En ?? role });
      }
    }
    const extras = [...layerRows, ...inventory[section].filter((role) => !known.has(role))];
    const seen = new Set();
    for (const role of extras) {
      if (known.has(role) || seen.has(role)) continue;
      seen.add(role);
      rows.push({ section, role, group: 'extras', groupLabel: '추가 역할 · Extras',
        labelKo: ROLE_DISPLAY_NAMES[role]?.Ko ?? role, labelEn: ROLE_DISPLAY_NAMES[role]?.En ?? role });
    }
  }
  return rows;
}

function matchesModelFamily(modelId, family) {
  const normalizedId = modelId.toLowerCase();
  const escaped = family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leading = family.startsWith('gpt-') ? '(?:^|[/.:_])' : '(?:^|[/.:_-])';
  return new RegExp(`(${leading}${escaped})(?=$|[^a-z0-9])`).test(normalizedId);
}

function getBareModelId(modelId) {
  const segments = modelId.split('/', 2);
  return segments.length > 1 && segments[1] ? segments[1] : modelId;
}

function getProviderApi(modelId, provider) {
  if (BUILTIN_THINKING_MAPS[modelId]) return BUILTIN_THINKING_MAPS[modelId].api;
  if (provider === 'commandcode') return 'openai-completions';
  if (provider === 'commandcode-anthropic') return 'anthropic-messages';
  return '';
}

function getEffectiveThinkingLevelMap(modelId) {
  if (BUILTIN_THINKING_MAPS[modelId]) return BUILTIN_THINKING_MAPS[modelId].map;
  if (modelId.split('/')[0] === 'ollama') return OLLAMA_THINKING_LEVEL_MAP;
  return null;
}

function supportsXhigh(modelId, map) {
  if (map) {
    if (Object.hasOwn(map, 'xhigh') && map.xhigh === null) return false;
    if (Object.hasOwn(map, 'xhigh')) return true;
    return false;
  }
  const id = getBareModelId(modelId);
  return XHIGH_MODEL_IDS.some((family) => matchesModelFamily(id, family));
}

function supportsMax(modelId, api, map) {
  if (map) {
    if (Object.hasOwn(map, 'max') && map.max === null) return false;
    if (Object.hasOwn(map, 'max')) return true;
    return false;
  }
  const id = getBareModelId(modelId);
  if (OPENAI_MAX_APIS.includes(api) &&
      (matchesModelFamily(id, 'gpt-5.6-sol') || matchesModelFamily(id, 'gpt-6-sol') ||
       matchesModelFamily(id, 'gpt-6-astra'))) return true;
  return MAX_MODEL_IDS.some((family) => matchesModelFamily(id, family));
}

export function getSupportedThinkingLevels(modelId, reasoning = true) {
  if (!reasoning) return ['off'];
  const provider = modelId.split('/')[0];
  const api = getProviderApi(modelId, provider);
  const map = getEffectiveThinkingLevelMap(modelId);
  const result = [];
  for (const level of EXTENDED_THINKING_LEVELS) {
    if (map && Object.hasOwn(map, level) && map[level] === null) continue;
    if (level === 'xhigh' && !supportsXhigh(modelId, map)) continue;
    if (level === 'max' && !supportsMax(modelId, api, map)) continue;
    result.push(level);
  }
  return result;
}

export function testReasoningLevelSupported(modelId, level, reasoning = true) {
  if (typeof level !== 'string' || level.trim() === '') return false;
  return getSupportedThinkingLevels(modelId, reasoning).includes(level);
}

export function getClampedThinkingLevel(modelId, level, reasoning = true) {
  const available = getSupportedThinkingLevels(modelId, reasoning);
  if (available.includes(level)) return level;
  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex < 0) return available[0] ?? 'off';
  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i += 1) {
    if (available.includes(EXTENDED_THINKING_LEVELS[i])) return EXTENDED_THINKING_LEVELS[i];
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    if (available.includes(EXTENDED_THINKING_LEVELS[i])) return EXTENDED_THINKING_LEVELS[i];
  }
  return available[0] ?? 'off';
}

export const MODEL_TABLES = {
  profiles: PROFILE_META,
  roleInventory: ROLE_INVENTORY,
  routingGroups: ROUTING_GROUPS,
  roleDisplayNames: ROLE_DISPLAY_NAMES,
  modelAliasLabels: MODEL_ALIAS_LABELS,
  providerLabels: PROVIDER_LABELS,
  chatgptSubscriptionModelIds: CHATGPT_SUBSCRIPTION_MODEL_IDS,
  anthropicSubscriptionModelIds: ANTHROPIC_SUBSCRIPTION_MODEL_IDS,
  builtinModelProfiles: BUILTIN_MODEL_PROFILES,
  thinkingMaps: BUILTIN_THINKING_MAPS,
};
