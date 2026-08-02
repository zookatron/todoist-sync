import { Alert, Button, Card, ErrorMessage, Input, Label, TextField } from '@heroui/react'
import { getSessionUser } from '@server/auth.js'
import { env } from '@server/env.js'
import { useState } from 'react'
import { Link, redirect, useNavigate, useSearchParams } from 'react-router'
import { authClient } from '../lib/auth-client.js'
import { textField } from '../lib/form.js'
import type { Route } from './+types/login'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Sign in · Todoist ⇄ Glassfrog Sync' }]
}

export async function loader({ request }: Route.LoaderArgs) {
  // Already signed in? Skip the form.
  if (await getSessionUser(request)) {
    throw redirect('/dashboard')
  }
  return { allowSignup: env.ALLOW_SIGNUP }
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)

    const form = new FormData(event.currentTarget)
    const result = await authClient.signIn.email({
      email: textField(form, 'email'),
      password: textField(form, 'password'),
    })

    if (result.error) {
      setError(result.error.message ?? 'Could not sign in. Check your email and password.')
      setIsSubmitting(false)
      return
    }

    await navigate(searchParams.get('redirectTo') ?? '/dashboard')
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <Card.Header>
          <Card.Title>Sign in</Card.Title>
          <Card.Description>Access your Todoist ⇄ Glassfrog sync settings.</Card.Description>
        </Card.Header>

        <form
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
        >
          <Card.Content className="flex flex-col gap-4">
            {error && (
              <Alert status="danger">
                <Alert.Content>
                  <Alert.Description>{error}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}

            <TextField name="email" type="email" isRequired autoComplete="email">
              <Label>Email</Label>
              <Input placeholder="you@example.com" />
              <ErrorMessage />
            </TextField>

            <TextField name="password" type="password" isRequired autoComplete="current-password">
              <Label>Password</Label>
              <Input />
              <ErrorMessage />
            </TextField>
          </Card.Content>

          <Card.Footer className="flex flex-col items-stretch gap-3">
            <Button type="submit" variant="primary" fullWidth isDisabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>

            {loaderData.allowSignup && (
              <p className="text-center text-foreground-secondary text-sm">
                No account yet?{' '}
                <Link to="/signup" className="underline">
                  Create one
                </Link>
              </p>
            )}
          </Card.Footer>
        </form>
      </Card>
    </main>
  )
}
