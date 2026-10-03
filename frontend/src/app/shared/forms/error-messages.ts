import type { ValidationErrors } from '@angular/forms';

function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function builtInMessage(
  key: string,
  details: Record<string, unknown>,
  label: string,
): string | null {
  switch (key) {
    case 'required':
      return `${label} is required.`;
    case 'minlength':
      return `${label} needs at least ${String(details['requiredLength'])} characters.`;
    case 'maxlength':
      return `${label} can have at most ${String(details['requiredLength'])} characters.`;
    case 'min':
      return `Enter ${String(details['min'])} or more.`;
    case 'max':
      return `Enter ${String(details['max'])} or less.`;
    case 'pattern':
      return `${label} is not in the expected format.`;
    default:
      return null;
  }
}

/**
 * The message to show for a control's errors, or null when it has none. Messages come from, in this
 * order: a `server` error (set from an API response), any error that carries its own text
 * (`{ key: 'text' }` or `{ key: { message: 'text' } }`, which is how this app's validators report),
 * then Angular's built-in validators.
 *
 * Custom messages come before the built-in ones on purpose. A money input holding text that is not
 * an amount has the value `null`, so `required` fires as well, but "Enter an amount like 12.50" is
 * the useful thing to say, not "Amount is required".
 */
export function controlErrorMessage(errors: ValidationErrors | null, label: string): string | null {
  if (!errors) return null;

  const server: unknown = errors['server'];
  if (typeof server === 'string') return server;

  const entries = Object.entries(errors) as [string, unknown][];
  for (const [, value] of entries) {
    if (typeof value === 'string') return value;
    if (hasMessage(value)) return value.message;
  }
  for (const [key, value] of entries) {
    const details = (typeof value === 'object' && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    const message = builtInMessage(key, details, label);
    if (message) return message;
  }
  return `${label} is not valid.`;
}
