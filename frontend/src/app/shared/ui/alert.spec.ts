import { Component, signal } from '@angular/core';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { Alert, type AlertLive, type AlertTone } from './alert';
import { Button } from './button';

@Component({
  selector: 'app-alert-host',
  imports: [Alert, Button],
  template: `
    <app-alert [tone]="tone()" [title]="title()" [live]="live()">
      {{ message }}
      @if (withAction()) {
        <button
          alertAction
          appButton
          variant="secondary"
          size="sm"
          (click)="clicks.set(clicks() + 1)"
        >
          Try again
        </button>
      }
    </app-alert>
    <p id="clicks">{{ clicks() }}</p>
  `,
})
class AlertHost {
  readonly message = 'The amount is more than the budget holds.';
  readonly tone = signal<AlertTone>('error');
  readonly title = signal<string | undefined>(undefined);
  readonly live = signal<AlertLive | undefined>(undefined);
  readonly withAction = signal(false);
  readonly clicks = signal(0);
}

describe('Alert', () => {
  async function setup() {
    const fixture = await render(AlertHost);
    const element = fixture.nativeElement as HTMLElement;
    const host = fixture.componentInstance;
    return {
      fixture,
      host,
      element,
      alert: () => element.querySelector('app-alert') as HTMLElement,
      set: async (change: () => void) => {
        change();
        await settle(fixture);
      },
    };
  }

  it('is announced as an alert when it is an error', async () => {
    const { element } = await setup();

    const alert = getByRole(element, 'alert');
    expect(textOf(alert)).toBe('The amount is more than the budget holds.');
  });

  it.each<AlertTone>(['warning', 'info', 'success'])(
    'is read in turn with the page, not announced, when it is %s',
    async (tone) => {
      const { element, host, set } = await setup();
      await set(() => host.tone.set(tone));

      expect(queryByRole(element, 'alert')).toBeNull();
      expect(queryByRole(element, 'status')).toBeNull();
      expect(textOf(element)).toContain('The amount is more than the budget holds.');
    },
  );

  it('can be a status, or an alert, whatever its tone, for a message that is the result of an action', async () => {
    const { element, host, set } = await setup();
    await set(() => {
      host.tone.set('warning');
      host.live.set('alert');
    });
    expect(getByRole(element, 'alert')).toBeTruthy();

    await set(() => {
      host.tone.set('error');
      host.live.set('status');
    });
    expect(queryByRole(element, 'alert')).toBeNull();
    expect(textOf(getByRole(element, 'status'))).toBe('The amount is more than the budget holds.');

    await set(() => host.live.set('none'));
    expect(queryByRole(element, 'alert')).toBeNull();
    expect(queryByRole(element, 'status')).toBeNull();
  });

  it('has an icon for its tone, which is only decoration', async () => {
    const { element, host, set } = await setup();
    const shape = () => element.querySelector('svg path')?.getAttribute('d');

    const error = shape();
    await set(() => host.tone.set('info'));
    const info = shape();
    await set(() => host.tone.set('success'));
    const success = shape();

    expect(new Set([error, info, success]).size).toBe(3);
    expect(element.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the tone on a soft background and tints the icon and the title, never the text', async () => {
    const { element, host, set, alert } = await setup();
    await set(() => {
      host.tone.set('warning');
      host.title.set('Over budget');
    });

    const box = alert().firstElementChild as HTMLElement;
    expect(box.classList).toContain('bg-warning-soft');
    expect(box.classList).toContain('text-ink');
    expect(element.querySelector('p.font-semibold')?.classList).toContain('text-warning');
  });

  it('shows a title above the message, as part of what is announced', async () => {
    const { element, host, set } = await setup();
    await set(() => host.title.set('Over budget'));

    expect(textOf(getByRole(element, 'alert'))).toBe(
      'Over budget The amount is more than the budget holds.',
    );
  });

  it('does not turn its title into a tooltip of the whole message', async () => {
    const { host, set, alert } = await setup();
    await set(() => host.title.set('Over budget'));

    expect(alert().getAttribute('title')).toBeNull();
  });

  it('has room for a button, which works', async () => {
    const { fixture, element, host, set } = await setup();
    await set(() => host.withAction.set(true));

    getByRole(getByRole(element, 'alert'), 'button', 'Try again').click();
    await settle(fixture);

    expect(host.clicks()).toBe(1);
  });

  it('has nothing for a screen reader to complain about', async () => {
    const { element, host, set } = await setup();
    await set(() => {
      host.title.set('Over budget');
      host.withAction.set(true);
    });
    expect(a11yProblems(element)).toEqual([]);
  });
});
