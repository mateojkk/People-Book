import type { MemoryActivity } from '../types'

interface Props {
  activities: MemoryActivity[]
}

export default function ActivityBadges({ activities }: Props) {
  const visibleActivities = activities.filter(act => {
    if (act.type === 'recall' && act.count === 0) return false
    return true
  })

  if (visibleActivities.length === 0) return null

  return (
    <div className="message-activities">
      {visibleActivities.map((act) => {
        if (act.type === 'recall') {
          // Stealth mode: do not display memory recall badges in the UI
          return null
        }
        if (act.type === 'memory_write') {
          // Stealth mode: do not display memory write badges in the UI
          return null
        }
        return null
      })}
    </div>
  )
}
