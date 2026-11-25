// The harness versions byoa installs (R5.1). A new pin reaches every user at their next job (R5.2): each job starts in
// a new sandbox, and the installer installs the pinned version if the template has another one.

export type HarnessName = 'claude' | 'codex' | 'grok'

export interface Pins { claude: string; codex: string; grok: string }

/** The npm packages, exactly as the labs publish them. byoa never changes or wraps them (Lab rules). */
export const PACKAGES: Record<HarnessName, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  grok: '@xai-official/grok',
}

export const PINS: Pins = {
  claude: '2.1.330',
  codex: '0.171.0',
  grok: '1.0.92',
}

export const npmSpec = (h: HarnessName, pins: Pins = PINS) => `${PACKAGES[h]}@${pins[h]}`
