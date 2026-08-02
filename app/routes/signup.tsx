import { Alert, Button, Card, ErrorMessage, Input, Label, TextField } from '@heroui/react'
import { getSessionUser } from '@server/utils/auth.js'
import { env } from '@server/utils/env.js'
import { useState } from 'react'
import { Link, redirect, useNavigate } from 'react-router'
import { authClient } from '../lib/auth-client.js'
import { textField } from '../lib/form.js'
import type { Route } from './+types/signup'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Create account · Todoist ⇄ Glassfrog Sync' }]
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await getSessionUser(request)) {
    throw redirect('/dashboard')
  }

  // Signups closed: don't render a form that the server will reject anyway.
  if (!env.ALLOW_SIGNUP) {
    throw redirect('/login')
  }

  return null
}

export default function Signup() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const form = new FormData(event.currentTarget)
    const password = textField(form, 'password')

    if (password !== textField(form, 'confirmPassword')) {
      setError('Passwords do not match.')
      return
    }

    setIsSubmitting(true)

    const email = textField(form, 'email')
    const result = await authClient.signUp.email({
      email,
      password,
      name: textField(form, 'name') || email,
    })

    if (result.error) {
      setError(result.error.message ?? 'Could not create the account.')
      setIsSubmitting(false)
      return
    }

    await navigate('/dashboard')
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <Card.Header>
          <Card.Title>Create your account</Card.Title>
          <Card.Description>
            This app is meant for one person. Set ALLOW_SIGNUP=false afterwards to close it.
          </Card.Description>
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

            <TextField name="name" type="text" autoComplete="name">
              <Label>Name</Label>
              <Input placeholder="Optional" />
            </TextField>

            <TextField name="email" type="email" isRequired autoComplete="email">
              <Label>Email</Label>
              <Input placeholder="you@example.com" />
              <ErrorMessage />
            </TextField>

            <TextField name="password" type="password" isRequired autoComplete="new-password">
              <Label>Password</Label>
              <Input placeholder="At least 12 characters" />
              <ErrorMessage />
            </TextField>

            <TextField
              name="confirmPassword"
              type="password"
              isRequired
              autoComplete="new-password"
            >
              <Label>Confirm password</Label>
              <Input />
              <ErrorMessage />
            </TextField>
          </Card.Content>

          <Card.Footer className="flex flex-col items-stretch gap-3">
            <Button type="submit" variant="primary" fullWidth isDisabled={isSubmitting}>
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </Button>

            <p className="text-center text-foreground-secondary text-sm">
              Already have an account?{' '}
              <Link to="/login" className="underline">
                Sign in
              </Link>
            </p>
          </Card.Footer>
        </form>
      </Card>
    </main>
  )
}
