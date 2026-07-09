export type MessageRole = 'user' | 'assistant'

export interface MemoryActivity {
  type: 'memory_write' | 'recall'
  tag?: string
  entity?: string
  status?: string
  text?: string
  query?: string
  count?: number
  results?: string[]
}

export interface AgentStatus {
  agent: 'B' | 'A' | 'C' | 'synthesis'
  status: 'running' | 'done'
  label?: string
  count?: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  activities: MemoryActivity[]
  agentSteps: AgentStatus[]
  streaming?: boolean
}

export interface MemoryEntry {
  id: string
  tag: 'ECOSYSTEM' | 'DECISION' | 'OPPORTUNITY' | 'RECALL'
  entity: string
  status?: string
  text?: string
  timestamp: Date
}

export interface ChatSession {
  id: string
  title: string
  timestamp: number
  messages: ChatMessage[]
}
