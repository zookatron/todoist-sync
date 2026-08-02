import { Card } from '@heroui/react'
import type { Route } from './+types/dashboard'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Dashboard · Todoist ⇄ Glassfrog Sync' }]
}

export default function Dashboard() {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <Card.Header>
          <Card.Title>Setup</Card.Title>
          <Card.Description>
            Connect Todoist, add your Glassfrog API key, and choose a root project.
          </Card.Description>
        </Card.Header>
      </Card>
    </div>
  )
}
