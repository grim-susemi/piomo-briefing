// Shared constants for the four PiOMO primary agents.
// Pure ESM: no imports.

export const AGENT_IDS = ['sisyphus', 'hephaestus', 'prometheus', 'atlas'];

export const DISPLAY = {
  sisyphus: 'Sisyphus',
  hephaestus: 'Hephaestus',
  prometheus: 'Prometheus',
  atlas: 'Atlas',
};

export const COLORS = {
  sisyphus: '#00CED1',
  hephaestus: '#D97706',
  prometheus: '#A78BFA',
  atlas: '#10B981',
};

export const LANES = ['daily-normal', 'daily-heavy', 'geeky-normal', 'geeky-heavy'];

export const DEFAULT_LANE = {
  sisyphus: 'daily-normal',
  hephaestus: 'geeky-normal',
  prometheus: 'daily-heavy',
  atlas: 'daily-normal',
};

// Copied verbatim from OMO_Native_Profile_Switcher.ps1:792-805. Each rung keeps
// its ordered provider list; resolution walks that list, so a subscription
// provider wins over a metered one for the same model.
export const BUILTIN_CHAINS = {
  'daily-normal': [
    {
      providers: ['anthropic-subscription', 'anthropic', 'anthropic-api', 'github-copilot', 'opencode'],
      model: 'claude-opus-5-5',
      variant: 'medium',
    },
    {
      providers: ['kimi-coding', 'kimi-for-coding', 'moonshotai', 'opencode-go'],
      model: 'kimi-k3',
      variant: 'max',
    },
    {
      providers: ['zai', 'zai-coding-cn', 'opencode-go'],
      model: 'glm-5.3',
      variant: 'max',
    },
  ],
  'daily-heavy': [
    {
      providers: ['anthropic-subscription', 'anthropic', 'anthropic-api', 'github-copilot', 'opencode'],
      model: 'claude-fable-5-1',
      variant: 'xhigh',
    },
  ],
  'geeky-normal': [
    {
      providers: ['chatgpt-subscription', 'openai'],
      model: 'gpt-6.1-sol-fast',
      variant: 'medium',
    },
    {
      providers: ['chatgpt-subscription', 'openai'],
      model: 'gpt-6.1-sol',
      variant: 'medium',
    },
    {
      providers: ['chatgpt-subscription', 'openai', 'github-copilot', 'opencode'],
      model: 'gpt-5.6-sol',
      variant: 'medium',
    },
  ],
  'geeky-heavy': [
    {
      providers: ['chatgpt-subscription', 'openai', 'github-copilot', 'opencode'],
      model: 'gpt-6-astra',
      variant: 'high',
    },
  ],
};

export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
