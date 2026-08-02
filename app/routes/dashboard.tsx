import { Alert, Card } from '@heroui/react'
import { env } from '@server/env.js'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import {
  ActivityCard,
  GlassfrogCard,
  RootProjectCard,
  SyncCard,
  TodoistCard,
} from '../components/integration-cards.js'
import { useTRPC } from '../lib/trpc.js'
import type { Route } from './+types/dashboard'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Dashboard · Todoist ⇄ Glassfrog Sync' }]
}

export function loader(_: Route.LoaderArgs) {
  // Surfaced in the UI so the poll cadence is visible without reading .env.
  return { intervalSeconds: Math.round(env.SYNC_INTERVAL_MS / 1000) }
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams()
  const trpc = useTRPC()

  const todoist = useQuery(trpc.todoist.status.queryOptions())
  const glassfrog = useQuery(trpc.glassfrog.status.queryOptions())

  const rootTodoistProjectId = todoist.data?.connected ? todoist.data.rootTodoistProjectId : null

  const steps = [
    { label: 'Connect your Todoist account', done: Boolean(todoist.data?.connected) },
    { label: 'Save your Glassfrog API key', done: Boolean(glassfrog.data?.connected) },
    { label: 'Choose a root Todoist project', done: Boolean(rootTodoistProjectId) },
  ]

  const setupComplete = steps.every((step) => step.done)

  return (
    <div className="flex flex-col gap-6">
      {searchParams.get('todoist') === 'connected' && (
        <Alert status="success">
          <Alert.Content>
            <Alert.Description>Todoist connected.</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {!setupComplete && (
        <Card>
          <Card.Header>
            <Card.Title>Setup</Card.Title>
            <Card.Description>Nothing syncs until all three steps are done.</Card.Description>
          </Card.Header>
          <Card.Content>
            <ol className="flex flex-col gap-2 text-sm">
              {steps.map((step) => (
                <li key={step.label} className="flex items-center gap-2">
                  <span aria-hidden>{step.done ? '✓' : '○'}</span>
                  <span className={step.done ? 'text-foreground-secondary line-through' : ''}>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
          </Card.Content>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <TodoistCard connectError={searchParams.get('todoist_error')} />
        <GlassfrogCard />
        <RootProjectCard todoistConnected={Boolean(todoist.data?.connected)} />
        <SyncCard intervalSeconds={loaderData.intervalSeconds} />
      </div>

      <ActivityCard />
    </div>
  )
}
