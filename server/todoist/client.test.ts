import { TodoistRequestError } from '@doist/todoist-sdk'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { connectedUser, DatabaseSimulator, TodoistSimulator } from '../testing/index.js'
import { callTodoist, getTodoistApi } from './client.js'

/**
 * `getTodoistApi`/`callTodoist` against the real SDK and a static personal token — no
 * refresh branch left to exercise, just "not connected" and the 429/5xx retry loop.
 */
new DatabaseSimulator()
const todoist = new TodoistSimulator()

let userId: string

beforeEach(async () => {
  userId = (await connectedUser()).user.id
})

describe('getTodoistApi', () => {
  it('throws when the user has never connected Todoist', async () => {
    await expect(getTodoistApi('never-connected')).rejects.toThrow('has not connected Todoist')
  })

  it('builds a client from the stored token', async () => {
    todoist.addProjects([{ id: 'td-root', name: 'Root' }])

    const api = await getTodoistApi(userId)
    const page = await api.getProjects({})

    expect(page.results.map((project) => project.name)).toEqual(['Root'])
  })
})

describe('callTodoist', () => {
  it('retries on 429 and succeeds once the server recovers', async () => {
    todoist.addProjects([{ id: 'td-root', name: 'Root' }])

    let attempts = 0
    todoist.useForTest([
      http.get('https://api.todoist.com/api/v1/projects', () => {
        attempts += 1
        if (attempts === 1) {
          return HttpResponse.json({ error: 'Too Many Requests' }, { status: 429 })
        }
        return HttpResponse.json({ results: [], next_cursor: null })
      }),
    ])

    await callTodoist(userId, (api) => api.getProjects({}))

    expect(attempts).toBe(2)
  })

  it('does not retry a 401 — the token is simply bad', async () => {
    todoist.useForTest([
      http.get('https://api.todoist.com/api/v1/projects', () =>
        HttpResponse.json({ error: 'Invalid token' }, { status: 401 }),
      ),
    ])

    await expect(callTodoist(userId, (api) => api.getProjects({}))).rejects.toBeInstanceOf(
      TodoistRequestError,
    )
  })
})
