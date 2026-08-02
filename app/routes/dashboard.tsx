import { Card } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../lib/trpc.js'
import type { Route } from './+types/dashboard'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Dashboard · Todoist ⇄ Glassfrog Sync' }]
}

export default function Dashboard() {
  const trpc = useTRPC()
  const status = useQuery(trpc.sync.status.queryOptions())
  const config = useQuery(trpc.config.get.queryOptions())

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <Card.Header>
          <Card.Title>Sync status</Card.Title>
          <Card.Description>
            Connect Todoist, add your Glassfrog API key, and choose a root project.
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex gap-8 text-sm">
          <div>
            <div className="text-foreground-secondary">Mapped projects</div>
            <div className="font-semibold text-lg">{status.data?.mappedProjects ?? '—'}</div>
          </div>
          <div>
            <div className="text-foreground-secondary">Mapped tasks</div>
            <div className="font-semibold text-lg">{status.data?.mappedTasks ?? '—'}</div>
          </div>
          <div>
            <div className="text-foreground-secondary">Sync enabled</div>
            <div className="font-semibold text-lg">{config.data?.enabled ? 'Yes' : 'No'}</div>
          </div>
        </Card.Content>
      </Card>
    </div>
  )
}
