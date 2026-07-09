import type { AgentStatus } from '../types'

const AGENT_META: Record<string, { label: string; icon: string; color: string }> = {
  B: { label: 'Context Check',        icon: '🧠', color: 'var(--tag-recall)' },
  A: { label: 'Ecosystem Snapshot',   icon: '🌐', color: 'var(--tag-ecosystem)' },
  C: { label: 'Opportunity Radar',    icon: '💡', color: 'var(--tag-opportunity)' },
  synthesis: { label: 'Synthesizing', icon: '✍️', color: 'var(--text-secondary)' },
}

interface Props {
  steps: AgentStatus[]
}

export default function AgentPipeline({ steps }: Props) {
  if (steps.length === 0) return null

  return (
    <div className="agent-pipeline">
      {steps.map((step, i) => {
        const meta = AGENT_META[step.agent]
        const isDone = step.status === 'done'
        return (
          <div key={i} className={`agent-step ${isDone ? 'done' : 'running'}`}>
            <span className="agent-step-icon">{isDone ? '✓' : meta.icon}</span>
            <span className="agent-step-label" style={{ color: isDone ? 'var(--text-muted)' : meta.color }}>
              {step.label || meta.label}
              {!isDone && <span className="agent-step-pulse" />}
            </span>
            {isDone && step.count !== undefined && step.count > 0 && (
              <span className="agent-step-count">+{step.count}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
