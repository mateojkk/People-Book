export const uid = () => Math.random().toString(36).slice(2)

export const TAG_ICONS: Record<string, string> = {
  ECOSYSTEM: '🌐',
  DECISION: '🎯',
  OPPORTUNITY: '💡',
  RECALL: '🧠',
}

export const STARTER_PROMPTS = [
  '🏗️  I want to build a photo app on Walrus',
  '📦  What SDK should I use for blob storage?',
  '💰  Are there any active bounties I should know about?',
  '🔄  Picking up where I left off…',
]
