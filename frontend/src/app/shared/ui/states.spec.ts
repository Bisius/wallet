import { Component, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { apiError, render, settle } from '../../../testing/harness';
import { EmptyState, ErrorState, LoadingState } from './states';

@Component({
  selector: 'app-states-host',
  imports: [LoadingState, EmptyState, ErrorState],
  template: `
    <app-loading-state label="Loading budgets…" />
    <app-empty-state title="No budgets yet" description="Add one to get started.">
      <button type="button">Add budget</button>
    </app-empty-state>
    <app-error-state
      title="Could not load budgets"
      [error]="error()"
      (retry)="retries.set(retries() + 1)"
    />
    <p id="retries">{{ retries() }}</p>
  `,
})
class StatesHost {
  readonly error = signal<unknown>(
    new HttpErrorResponse({
      status: 500,
      error: apiError('internal_error', 'The server ran into a problem.'),
    }),
  );
  readonly retries = signal(0);
}

describe('loading, empty and error states', () => {
  it('announces loading politely, in words', async () => {
    const fixture = await render(StatesHost);
    const status = getByRole(fixture.nativeElement, 'status');
    expect(textOf(status)).toBe('Loading budgets…');
  });

  it('explains an empty list and offers the next step', async () => {
    const fixture = await render(StatesHost);
    const element = fixture.nativeElement as HTMLElement;
    expect(textOf(element)).toContain('No budgets yet');
    expect(textOf(element)).toContain('Add one to get started.');
    expect(getByRole(element, 'button', 'Add budget')).toBeTruthy();
  });

  it('shows the message of the API error as an alert, and retries on request', async () => {
    const fixture = await render(StatesHost);
    const element = fixture.nativeElement as HTMLElement;
    const alert = getByRole(element, 'alert');
    expect(textOf(alert)).toContain('Could not load budgets');
    expect(textOf(alert)).toContain('The server ran into a problem.');

    getByRole(alert, 'button', 'Try again').click();
    await settle(fixture);
    expect((element.querySelector('#retries') as HTMLElement).textContent).toBe('1');
  });

  it('falls back to what the HTTP status means when the response has no ApiError body', async () => {
    const fixture = await render(StatesHost);
    fixture.componentInstance.error.set(new HttpErrorResponse({ status: 0 }));
    await settle(fixture);

    expect(textOf(getByRole(fixture.nativeElement, 'alert'))).toContain("Can't reach the server");
  });

  it('can hide the retry button', async () => {
    const fixture = await render(StatesHost);
    const alert = getByRole(fixture.nativeElement, 'alert');
    expect(queryByRole(alert, 'button', 'Try again')).not.toBeNull();
  });
});
