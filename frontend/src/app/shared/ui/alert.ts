import { Component, computed, input } from '@angular/core';
import { Icon, type IconName } from './icon';

export type AlertTone = 'error' | 'warning' | 'info' | 'success';

/**
 * How a message is announced. `alert` interrupts the screen reader (something failed, now), `status`
 * waits for it to be idle (a result, a count), `none` leaves it to be read in turn with the page.
 */
export type AlertLive = 'alert' | 'status' | 'none';

interface ToneLook {
  icon: IconName;
  /** The soft background of the tone. The text stays `ink`: only the icon and the title are tinted. */
  box: string;
  /** The tone's own color, for the icon and the title: always on its soft background (checked pairs). */
  accent: string;
  live: AlertLive;
}

const TONES: Record<AlertTone, ToneLook> = {
  error: { icon: 'alert', box: 'bg-negative-soft', accent: 'text-negative', live: 'alert' },
  warning: { icon: 'alert', box: 'bg-warning-soft', accent: 'text-warning', live: 'none' },
  info: { icon: 'info', box: 'bg-accent-soft', accent: 'text-accent-text', live: 'none' },
  success: { icon: 'check-circle', box: 'bg-positive-soft', accent: 'text-positive', live: 'none' },
};

/**
 * A message inside the page: something failed, needs care, is worth knowing or went well.
 *
 * ```html
 * <app-alert tone="error">{{ error }}</app-alert>
 * <app-alert tone="warning" title="Over-allocated by €50.00">Lower a budget or add income.</app-alert>
 * <app-alert tone="error" title="Nothing was imported"><button alertAction appButton …>Try again</button></app-alert>
 * ```
 *
 * The tone is told by an icon and, when there is one, the title, never by color alone. The text
 * is the default content, a button or link for the message goes into an element marked
 * `alertAction`.
 *
 * Announcing: an `error` is `role="alert"`, the other tones are read in turn with the page. Say
 * `live="status"` (or `"alert"`) when the message appears as the result of something the person
 * just did, or when it is a live region that changes. If the region has to exist before the message
 * does, keep your own `role="status"` element around the alert and leave `live` alone.
 *
 * For a failed request use `app-error-state`, which is this with the API's message and "Try again".
 */
@Component({
  selector: 'app-alert',
  imports: [Icon],
  template: `
    <div [attr.role]="role()" [class]="boxClasses()">
      <app-icon [name]="look().icon" [class]="'mt-0.5 ' + look().accent" />
      <div class="min-w-0 flex-1 space-y-1">
        @if (title()) {
          <p [class]="'font-semibold ' + look().accent">{{ title() }}</p>
        }
        <div class="empty:hidden"><ng-content /></div>
        <div class="pt-1 empty:hidden"><ng-content select="[alertAction]" /></div>
      </div>
    </div>
  `,
  // `title` is an input here, not a tooltip: a static title attribute would also show on hover.
  host: { class: 'block', '[attr.title]': 'null' },
})
export class Alert {
  readonly tone = input<AlertTone>('info');
  /** A short bold line above the message. */
  readonly title = input<string>();
  /** How it is announced. By default an error is an alert and the other tones are not announced. */
  readonly live = input<AlertLive>();

  protected readonly look = computed(() => TONES[this.tone()]);
  protected readonly role = computed(() => {
    const live = this.live() ?? this.look().live;
    return live === 'none' ? null : live;
  });
  protected readonly boxClasses = computed(
    () =>
      `flex items-start gap-2.5 rounded-control px-3.5 py-3 text-sm text-ink ${this.look().box}`,
  );
}
