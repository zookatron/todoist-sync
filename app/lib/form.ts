/**
 * Reads a text field out of a submitted form.
 *
 * `FormData.get()` returns `string | File | null`, so stringifying the result blindly
 * would turn an unexpected file upload into the literal `"[object File]"`. Anything that
 * is not text reads as empty, which the field's own validation then rejects.
 */
export function textField(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}
