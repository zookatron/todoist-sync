import { describe, expect, it } from 'vitest'
import { isActive, toProjectName } from './desired-tree.js'

describe('toProjectName', () => {
  it('trims surrounding whitespace', () => {
    expect(toProjectName('  Marketing  ')).toBe('Marketing')
  })

  it('falls back to a placeholder for empty or missing names', () => {
    expect(toProjectName('')).toBe('Untitled')
    expect(toProjectName('   ')).toBe('Untitled')
    expect(toProjectName(null)).toBe('Untitled')
    expect(toProjectName(undefined)).toBe('Untitled')
  })

  it('truncates to Todoist’s 120-character limit', () => {
    const name = toProjectName('x'.repeat(200))

    expect(name).toHaveLength(120)
    expect(name.endsWith('…')).toBe(true)
  })

  it('leaves a name at exactly the limit untouched', () => {
    expect(toProjectName('x'.repeat(120))).toBe('x'.repeat(120))
  })
})

describe('isActive', () => {
  it('treats only unfinished Glassfrog statuses as active', () => {
    expect(isActive('current')).toBe(true)
    expect(isActive('waiting')).toBe(true)
    expect(isActive('scheduled')).toBe(true)
    expect(isActive('someday')).toBe(true)

    expect(isActive('completed')).toBe(false)
    expect(isActive('cancelled')).toBe(false)
    expect(isActive('archived')).toBe(false)
  })
})
