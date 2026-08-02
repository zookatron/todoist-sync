import { Button } from '@heroui/react'
import type { Route } from './+types/home'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Todoist ⇄ Glassfrog Sync' }]
}

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6">
      <h1 className="font-semibold text-2xl">Todoist ⇄ Glassfrog Sync</h1>
      <Button variant="primary">Get started</Button>
    </main>
  )
}
