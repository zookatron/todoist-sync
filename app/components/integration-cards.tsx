import {
  Alert,
  Button,
  Card,
  ErrorMessage,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTRPC } from '../lib/trpc.js'

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return 'never'
  return new Date(value).toLocaleString()
}

export function TodoistCard({ connectError }: { connectError: string | null }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const status = useQuery(trpc.todoist.status.queryOptions())

  const disconnect = useMutation(
    trpc.todoist.disconnect.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(),
    }),
  )

  return (
    <Card>
      <Card.Header>
        <Card.Title>Todoist</Card.Title>
        <Card.Description>
          Authorize access so tasks and projects can be read and written.
        </Card.Description>
      </Card.Header>

      <Card.Content className="flex flex-col gap-4">
        {connectError && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>Could not connect Todoist</Alert.Title>
              <Alert.Description>{connectError}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {status.data?.connected && status.data.needsReauth && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>Reconnection required</Alert.Title>
              <Alert.Description>
                The refresh token was rejected. Syncing is paused until you reconnect.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {status.data?.connected ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-foreground-secondary">Token expires</dt>
            <dd>{formatDate(status.data.expiresAt)}</dd>
          </dl>
        ) : (
          <p className="text-foreground-secondary text-sm">Not connected.</p>
        )}
      </Card.Content>

      <Card.Footer>
        {status.data?.connected ? (
          <Button variant="danger-soft" onPress={() => disconnect.mutate()}>
            Disconnect
          </Button>
        ) : (
          <Button variant="primary">
            <a href="/oauth/todoist/start">Connect Todoist</a>
          </Button>
        )}
      </Card.Footer>
    </Card>
  )
}

export function GlassfrogCard() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const status = useQuery(trpc.glassfrog.status.queryOptions())
  const [apiKey, setApiKey] = useState('')

  const save = useMutation(
    trpc.glassfrog.setApiKey.mutationOptions({
      onSuccess: () => {
        setApiKey('')
        return queryClient.invalidateQueries()
      },
    }),
  )

  const disconnect = useMutation(
    trpc.glassfrog.disconnect.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(),
    }),
  )

  return (
    <Card>
      <Card.Header>
        <Card.Title>Glassfrog</Card.Title>
        <Card.Description>
          Paste an API v5 key. It is verified against your account before being stored.
        </Card.Description>
      </Card.Header>

      <Card.Content className="flex flex-col gap-4">
        {save.error && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>{save.error.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {status.data?.connected ? (
          <p className="text-foreground-secondary text-sm">Connected.</p>
        ) : (
          <TextField
            name="apiKey"
            type="password"
            value={apiKey}
            onChange={setApiKey}
            autoComplete="off"
          >
            <Label>API v5 key</Label>
            <Input placeholder="Paste your Glassfrog API key" />
            <ErrorMessage />
          </TextField>
        )}
      </Card.Content>

      <Card.Footer>
        {status.data?.connected ? (
          <Button variant="danger-soft" onPress={() => disconnect.mutate()}>
            Remove key
          </Button>
        ) : (
          <Button
            variant="primary"
            isDisabled={apiKey.trim().length === 0 || save.isPending}
            onPress={() => save.mutate({ apiKey })}
          >
            {save.isPending ? 'Verifying…' : 'Test & save'}
          </Button>
        )}
      </Card.Footer>
    </Card>
  )
}

export function RootProjectCard({ todoistConnected }: { todoistConnected: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const status = useQuery(trpc.todoist.status.queryOptions())
  const projects = useQuery({
    ...trpc.todoist.listProjects.queryOptions(),
    enabled: todoistConnected,
  })

  const setRoot = useMutation(
    trpc.todoist.setRootProject.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(),
    }),
  )

  const items = projects.data ?? []
  const rootTodoistProjectId = status.data?.connected ? status.data.rootTodoistProjectId : null

  return (
    <Card>
      <Card.Header>
        <Card.Title>Root project</Card.Title>
        <Card.Description>
          The Todoist project the mirrored Glassfrog hierarchy lives under. Changing it rebuilds the
          tree beneath the new root.
        </Card.Description>
      </Card.Header>

      <Card.Content>
        {!todoistConnected ? (
          <p className="text-foreground-secondary text-sm">Connect Todoist first.</p>
        ) : (
          <Select
            selectedKey={rootTodoistProjectId ?? null}
            onSelectionChange={(key) => {
              if (key) setRoot.mutate({ projectId: String(key) })
            }}
            isDisabled={projects.isLoading || setRoot.isPending}
            aria-label="Root Todoist project"
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox items={items}>
                {(project: { id: string; name: string }) => (
                  <ListBox.Item id={project.id} textValue={project.name}>
                    {project.name}
                  </ListBox.Item>
                )}
              </ListBox>
            </Select.Popover>
          </Select>
        )}
      </Card.Content>
    </Card>
  )
}

export function SyncCard() {
  const trpc = useTRPC()
  const status = useQuery(trpc.todoist.status.queryOptions())
  const mappings = useQuery({
    ...trpc.sync.status.queryOptions(),
    refetchInterval: 10_000,
  })

  const triggerNow = useMutation(trpc.sync.triggerNow.mutationOptions())

  const ready = Boolean(status.data?.connected && status.data.rootTodoistProjectId)

  return (
    <Card>
      <Card.Header>
        <Card.Title>Sync</Card.Title>
        <Card.Description>
          Polls in the background once Todoist, Glassfrog, and a root project are set up.
        </Card.Description>
      </Card.Header>

      <Card.Content className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-foreground-secondary">Mapped projects</dt>
          <dd>{mappings.data?.mappedProjects ?? '—'}</dd>
          <dt className="text-foreground-secondary">Mapped tasks</dt>
          <dd>{mappings.data?.mappedTasks ?? '—'}</dd>
        </dl>
      </Card.Content>

      <Card.Footer>
        <Button
          variant="secondary"
          isDisabled={!ready || triggerNow.isPending}
          onPress={() => triggerNow.mutate()}
        >
          {triggerNow.isPending ? 'Queuing…' : 'Sync now'}
        </Button>
      </Card.Footer>
    </Card>
  )
}

export function ActivityCard() {
  const trpc = useTRPC()
  const logs = useQuery({
    ...trpc.sync.recentLogs.queryOptions({ limit: 25 }),
    refetchInterval: 10_000,
  })

  const entries = logs.data ?? []

  return (
    <Card>
      <Card.Header>
        <Card.Title>Activity</Card.Title>
        <Card.Description>The most recent sync operations.</Card.Description>
      </Card.Header>

      <Card.Content>
        {entries.length === 0 ? (
          <p className="text-foreground-secondary text-sm">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-foreground-secondary">
                <tr>
                  <th className="py-1 pr-4 font-medium">When</th>
                  <th className="py-1 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-default border-t">
                    <td className="py-1 pr-4 whitespace-nowrap">{formatDate(entry.createdAt)}</td>
                    <td className="py-1">{entry.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card.Content>
    </Card>
  )
}
