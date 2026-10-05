import {
  afterNextRender,
  Component,
  computed,
  DOCUMENT,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type {
  TelegramLinkDto,
  TelegramPairingDto,
  TelegramProblem,
  TelegramStatusDto,
} from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { formatDateTime, formatTime, formatTimeUntil } from '../../shared/format';
import { ActionMenu, MenuItem } from '../../shared/ui/action-menu';
import { Alert, type AlertTone } from '../../shared/ui/alert';
import { AsyncSection } from '../../shared/ui/async-section';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { KeyValue, KeyValues } from '../../shared/ui/key-values';
import { LinkButton } from '../../shared/ui/link-button';
import { SectionHelp } from '../../shared/ui/section';
import { ToastService } from '../../shared/ui/toast.service';
import { TelegramApi } from './telegram.api';
import { TelegramNotifications } from './telegram-notifications';

/** How often the status is read again while a pairing code is pending or the bot is connecting. */
export const TELEGRAM_POLL_MS = 3000;

interface ProblemText {
  tone: AlertTone;
  title: string;
  text: string;
}

/** What each `problem` of a bot in the `error` state means for the owner, and what to do about it. */
const PROBLEMS: Record<TelegramProblem, ProblemText> = {
  invalid_token: {
    tone: 'error',
    title: 'Telegram refused the bot token',
    text:
      'The token in TELEGRAM_BOT_TOKEN is wrong or was revoked. Copy it from @BotFather again, ' +
      'fix the env file and restart Wallet. The bot stays off until then.',
  },
  conflict: {
    tone: 'error',
    title: 'Another program is using this bot',
    text:
      'Usually a second Wallet that has the same token: each Wallet needs a bot of its own, so use ' +
      'a separate bot for development. Wallet keeps trying again.',
  },
  unreachable: {
    tone: 'warning',
    title: "Telegram can't be reached",
    text: "Wallet can't connect to Telegram right now. It tries again by itself, so there is nothing to do unless this lasts.",
  },
  blocked: {
    tone: 'error',
    title: 'You blocked the bot',
    text: "The bot can't write to your chat while it is blocked. Unblock it in Telegram, then send it a message.",
  },
};

/** Said when the API reports an error state without saying which (it should not happen). */
const UNKNOWN_PROBLEM: ProblemText = {
  tone: 'error',
  title: 'The bot is not working',
  text: 'Wallet could not connect the bot to Telegram. It keeps trying again.',
};

const NOT_CONFIGURED =
  'This server has no bot token. Add TELEGRAM_BOT_TOKEN to the env file and restart Wallet.';

/** The result of the last action, shown under the buttons until the next one. */
interface Notice {
  tone: 'success' | 'error';
  title: string;
  message: string;
}

/** Whether `link` is the same linking as the one before: a new link has a new time (and maybe a name). */
function linkIdentity(link: TelegramLinkDto | null): string | null {
  return link ? `${link.linkedAt}|${link.name}` : null;
}

/** "Anna (@anna)", or just the name for an account that has no username. */
function whoIs(link: TelegramLinkDto): string {
  return link.username ? `${link.name} (@${link.username})` : link.name;
}

/**
 * The Telegram bot (`GET /api/telegram`): how to set it up while it is off, why it cannot connect
 * while it is in error, the link to the owner's Telegram account and the notifications. The server
 * holds the token and every rule: this shows what the API says and asks it to link, unlink and send
 * a test message. It never sees or keeps the token.
 *
 * - **Not set up** (`configured: false`): four steps to turn it on.
 * - **Error**: one alert for the `problem` (wrong token, another program on the same bot, Telegram
 *   unreachable, the bot blocked). While `connecting` it says so. A linked account is still shown.
 * - **Not linked**: "Link Telegram" makes a one-time code (`POST /pairing`), shown with when it
 *   expires, "Open in Telegram" (the `deepLink`, when the bot knows its username; otherwise what to
 *   send by hand) and Cancel. While a code is pending the status is read every 3 seconds, so the
 *   page switches to "Linked" by itself when the code is used, and says so when the code expired.
 * - **Linked**: the account, "Send test message", and a menu with Re-link and Unlink (each behind a
 *   confirmation), then the notification preferences (`TelegramNotifications`).
 *
 * "Expired" is the server's word, not the browser clock's: the code is expired when the status says
 * no code is pending any more. The countdown beside it is only a hint, so a device with a wrong
 * clock cannot make a valid code look expired.
 *
 * Focus follows the Data section: a button that was busy gets focus back, one that went away with
 * its block hands it to the heading (or to the new code, which is what the person came to read).
 */
@Component({
  selector: 'app-telegram-section',
  imports: [
    ActionMenu,
    Alert,
    AsyncSection,
    Button,
    Icon,
    KeyValue,
    KeyValues,
    LinkButton,
    MenuItem,
    SectionHelp,
    TelegramNotifications,
  ],
  template: `
    <app-async-section
      heading="Telegram"
      description="Record spendings and get alerts from a Telegram chat."
      focusable
      [state]="state()"
      [error]="telegram.error()"
      loadingLabel="Loading Telegram…"
      errorTitle="Couldn't load Telegram"
      (retry)="telegram.reload()"
    >
      <p sectionHelp>
        Wallet's bot lets you record spendings and incomes from Telegram, and sends you alerts and
        reminders. It talks to the one account you link here: it never answers anyone else.
      </p>
      <p sectionHelp>
        Telegram chats are not end-to-end encrypted, so the budget names, amounts and notes the bot
        sends or receives pass through Telegram's servers. The bot token stays in the server's env
        file and is never shown here.
      </p>

      @if (status(); as s) {
        <div class="divide-y divide-line *:py-6 *:first:pt-0 *:last:pb-0">
          <div class="space-y-4">
            @if (!s.configured) {
              <p>Telegram is off. To record spendings from your phone, set the bot up:</p>
              <ol class="list-decimal space-y-2 pl-5">
                <li>
                  In Telegram, open <strong class="font-semibold">&#64;BotFather</strong>, send
                  <code>/newbot</code> and answer its questions. It gives you a bot token.
                </li>
                <li>
                  Put the token in the server's env file as
                  <code>TELEGRAM_BOT_TOKEN=your-bot-token</code>. Keep it private: Wallet never
                  shows it.
                </li>
                <li>Restart Wallet. It reads the token when it starts.</li>
                <li>Come back to this page and press <strong>Link Telegram</strong>.</li>
              </ol>
              <p class="text-sm text-muted">
                The README has the details, in the section “Telegram bot”.
              </p>
            } @else if (s.connection === 'connecting') {
              <app-alert tone="info" live="status" title="Connecting to Telegram…">
                This takes a few seconds. The page updates by itself.
              </app-alert>
            } @else if (problem(); as issue) {
              <app-alert [tone]="issue.tone" [title]="issue.title">{{ issue.text }}</app-alert>
            }

            @if (s.bot || s.link) {
              <dl appKeyValues>
                @if (s.bot) {
                  <div appKeyValue label="Bot">&#64;{{ s.bot.username }}</div>
                }
                @if (s.link; as link) {
                  <div appKeyValue label="Linked account">{{ link.name }}</div>
                  @if (link.username) {
                    <div appKeyValue label="Username">&#64;{{ link.username }}</div>
                  }
                  <div appKeyValue label="Linked since">{{ since(link) }}</div>
                }
              </dl>
            }

            @if (s.link; as link) {
              <div class="flex flex-wrap items-center gap-2">
                <button
                  #testButton
                  appButton
                  variant="secondary"
                  [loading]="testing()"
                  (click)="sendTest()"
                >
                  Send test message
                </button>
                <app-action-menu label="More actions for Telegram">
                  @if (!s.pairing) {
                    <button appMenuItem [disabled]="busy()" (click)="relink(link)">
                      <app-icon name="arrows-left-right" />
                      Re-link
                    </button>
                  }
                  <button appMenuItem destructive [disabled]="busy()" (click)="unlink(link)">
                    <app-icon name="trash" />
                    Unlink
                  </button>
                </app-action-menu>
              </div>
            } @else if (s.configured && !s.pairing && !expired() && s.connection !== 'error') {
              <p class="text-sm text-muted">
                Link your Telegram account to record spendings and get alerts on your phone.
              </p>
              <div>
                <button #codeButton appButton [loading]="linking()" (click)="createCode()">
                  Link Telegram
                </button>
              </div>
            }

            @if (notice(); as notice) {
              <app-alert
                [tone]="notice.tone"
                [title]="notice.title"
                [live]="notice.tone === 'success' ? 'status' : undefined"
              >
                {{ notice.message }}
              </app-alert>
            }

            @if (s.pairing; as pairing) {
              <div class="space-y-4" data-pairing>
                <p>
                  @if (s.link) {
                    This code links another account.
                  } @else {
                    This code links your Telegram account.
                  }
                  It works once.
                </p>
                <dl appKeyValues layout="stacked">
                  <div appKeyValue label="Pairing code">
                    <code
                      #code
                      tabindex="-1"
                      class="text-xl font-semibold tracking-widest select-all"
                      >{{ pairing.code }}</code
                    >
                  </div>
                  <div appKeyValue label="Expires">
                    {{ expiresIn(pairing) }}, at {{ expiresAt(pairing) }}
                  </div>
                </dl>
                @if (pairing.deepLink; as deepLink) {
                  <div>
                    <a
                      appLinkButton
                      variant="primary"
                      [href]="deepLink"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Telegram
                      <span class="sr-only">(opens in a new tab)</span>
                    </a>
                  </div>
                } @else {
                  <p>
                    In Telegram, send <code>/start {{ pairing.code }}</code> to
                    {{ s.bot ? '@' + s.bot.username : 'your bot' }}.
                  </p>
                }
                <div>
                  <button appButton variant="secondary" [loading]="cancelling()" (click)="cancel()">
                    Cancel
                  </button>
                </div>
              </div>
            } @else if (expired()) {
              <app-alert tone="warning" live="status" title="The code expired">
                That code can't be used any more. Make a new one to link Telegram.
                <button
                  #codeButton
                  alertAction
                  appButton
                  variant="secondary"
                  size="sm"
                  [loading]="linking()"
                  (click)="createCode()"
                >
                  Create a new code
                </button>
              </app-alert>
            }
          </div>

          @if (s.link) {
            <app-telegram-notifications [settings]="s.notifications" (saved)="telegram.reload()" />
          }
        </div>
      }
    </app-async-section>
  `,
  host: { class: 'block' },
})
export class TelegramSection {
  private readonly api = inject(TelegramApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly section = viewChild(AsyncSection);
  private readonly menu = viewChild(ActionMenu);
  // `read`: these buttons are components (`appButton`), so without it the query returns that instance.
  private readonly testButton = viewChild('testButton', { read: ElementRef<HTMLElement> });
  private readonly codeButton = viewChild('codeButton', { read: ElementRef<HTMLElement> });
  private readonly code = viewChild('code', { read: ElementRef<HTMLElement> });

  protected readonly telegram = this.api.status();
  protected readonly state = resourceState(this.telegram);
  protected readonly status = computed(() =>
    this.telegram.hasValue() ? this.telegram.value() : undefined,
  );

  /** What is wrong with the connection, while the bot is in the `error` state. */
  protected readonly problem = computed<ProblemText | null>(() => {
    const status = this.status();
    if (status?.connection !== 'error') return null;
    return (status.problem && PROBLEMS[status.problem]) || UNKNOWN_PROBLEM;
  });

  /** A code was pending and is no longer, and nobody linked or cancelled it: it ran out. */
  protected readonly expired = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  protected readonly linking = signal(false);
  protected readonly cancelling = signal(false);
  protected readonly testing = signal(false);
  /** An unlink or a re-link is under way, or its confirmation is open. */
  protected readonly busy = signal(false);

  /** The browser's clock at the last status: only the "expires in" hint reads it, never a decision. */
  private readonly now = signal(Date.now());
  /** Who was linked when a code was first seen pending: undefined while no code is pending. */
  private linkAtCode: string | null | undefined = undefined;

  /** Read again while a code is pending (it may be used, or run out) or the bot is connecting. */
  private readonly polling = computed(() => {
    const status = this.status();
    return status !== undefined && (status.pairing !== null || status.connection === 'connecting');
  });

  constructor() {
    effect(() => {
      const status = this.status();
      if (status) untracked(() => this.noticeStatus(status));
    });

    effect((onCleanup) => {
      if (!this.polling()) return;
      const timer = setInterval(() => this.telegram.reload(), TELEGRAM_POLL_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected since(link: TelegramLinkDto): string {
    return formatDateTime(link.linkedAt, this.settings.locale());
  }

  protected expiresIn(pairing: TelegramPairingDto): string {
    return formatTimeUntil(pairing.expiresAt, this.now(), this.settings.locale());
  }

  protected expiresAt(pairing: TelegramPairingDto): string {
    return formatTime(pairing.expiresAt, this.settings.locale());
  }

  /** Makes a one-time code. Also the code of a re-link: the confirmation came before. */
  protected async createCode(): Promise<void> {
    if (this.linking()) return;
    this.linking.set(true);
    this.notice.set(null);
    let made = false;
    try {
      await firstValueFrom(this.api.createPairing());
      await reloaded(this.telegram, this.injector);
      made = true;
    } catch (error) {
      const parsed = parseApiError(error);
      const notConfigured = parsed.code === 'telegram_not_configured';
      this.notice.set({
        tone: 'error',
        title: 'No code was made',
        message: notConfigured ? NOT_CONFIGURED : parsed.message,
      });
      // Whatever the API said, it knows the state now: show it.
      if (notConfigured) this.telegram.reload();
    } finally {
      this.linking.set(false);
      // The button was disabled while the request was out, which took focus away. A new code is
      // what the person came for, so it gets focus (a screen reader reads it out); a failure hands
      // it back to the button.
      this.afterRender(() => (made ? this.code() : this.codeButton())?.nativeElement.focus());
    }
  }

  protected async cancel(): Promise<void> {
    if (this.cancelling()) return;
    this.cancelling.set(true);
    this.notice.set(null);
    try {
      await firstValueFrom(this.api.cancelPairing());
      await reloaded(this.telegram, this.injector);
      // The person ended the code: that is not an expiry, whatever order the status came in.
      this.linkAtCode = undefined;
      this.expired.set(false);
    } catch (error) {
      this.notice.set({
        tone: 'error',
        title: 'The code was not cancelled',
        message: parseApiError(error).message,
      });
    } finally {
      this.cancelling.set(false);
      // The block with Cancel is gone, and the button that made the code (or the menu, for a
      // re-link) is where the person was.
      this.afterRender(() =>
        this.status()?.link ? this.menu()?.focus() : this.codeButton()?.nativeElement.focus(),
      );
    }
  }

  protected async sendTest(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    this.notice.set(null);
    try {
      await firstValueFrom(this.api.sendTest());
      this.notice.set({
        tone: 'success',
        title: 'Test message sent',
        message: 'A test message is in your Telegram chat.',
      });
    } catch (error) {
      const parsed = parseApiError(error);
      const code = parsed.code ?? (parsed.status === 503 ? 'telegram_unavailable' : null);
      switch (code) {
        case 'telegram_not_configured':
          this.notice.set({
            tone: 'error',
            title: 'No test message was sent',
            message: NOT_CONFIGURED,
          });
          this.telegram.reload();
          break;
        case 'telegram_not_linked':
          this.notice.set({
            tone: 'error',
            title: 'No test message was sent',
            message:
              'No Telegram account is linked, so there is no chat to send it to. Link one first.',
          });
          this.telegram.reload();
          break;
        case 'telegram_unavailable':
          this.notice.set({
            tone: 'error',
            title: 'No test message was sent',
            message:
              'The bot is not running right now, or Telegram refused the message. Check the connection above and try again in a moment.',
          });
          // The refusal is often the first sign of a problem the status does not show yet (a blocked
          // bot, a conflict): read it again so the alert above names the cause.
          this.telegram.reload();
          break;
        default:
          this.notice.set({
            tone: 'error',
            title: 'No test message was sent',
            message: parsed.message,
          });
      }
    } finally {
      this.testing.set(false);
      this.afterRender(() => this.testButton()?.nativeElement.focus());
    }
  }

  protected async relink(link: TelegramLinkDto): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const confirmed = await this.confirm.confirm({
        title: 'Link another Telegram account?',
        message:
          `${whoIs(link)} stays linked until the new code is used. Then the account that sent ` +
          `the code replaces it, and ${link.name} can no longer use the bot.`,
        confirmLabel: 'Create a new code',
      });
      if (confirmed) await this.createCode();
    } finally {
      this.busy.set(false);
    }
  }

  protected async unlink(link: TelegramLinkDto): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const confirmed = await this.confirm.confirm({
        title: 'Unlink this Telegram account?',
        message:
          `${whoIs(link)} can no longer use the bot, and Wallet stops sending it messages. ` +
          'Your notification settings are kept, and you can link an account again at any time.',
        confirmLabel: 'Unlink',
        tone: 'danger',
      });
      if (!confirmed) return;

      this.notice.set(null);
      try {
        await firstValueFrom(this.api.unlink());
        this.toast.success('Telegram unlinked.');
      } catch (error) {
        const parsed = parseApiError(error);
        if (parsed.code === 'not_found') this.toast.info('That account was already unlinked.');
        else {
          this.toast.error(`Couldn't unlink Telegram. ${parsed.message}`);
          return;
        }
      }
      await reloaded(this.telegram, this.injector);
      // The account and its menu are gone: the keyboard goes to the heading.
      this.afterRender(() => this.section()?.focusHeading());
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Called with every status the server gave: keeps the countdown's clock, and tells how a code
   * that was pending ended. Linked: the account changed. Otherwise it ran out (or was cancelled after
   * too many wrong tries) and the person is told. (Cancel ends the code itself, see `cancel`.)
   */
  private noticeStatus(status: TelegramStatusDto): void {
    this.now.set(Date.now());

    if (status.pairing !== null) {
      this.linkAtCode ??= linkIdentity(status.link);
      this.expired.set(false);
      return;
    }

    const before = this.linkAtCode;
    if (before === undefined) return;
    this.linkAtCode = undefined;
    if (status.link && linkIdentity(status.link) !== before) {
      this.toast.success(`Telegram linked: ${whoIs(status.link)}.`);
    } else {
      this.expired.set(true);
    }

    // The block that held the code goes away. If the keyboard was in it, it would fall to the page:
    // send it to the heading instead.
    const block = this.host.nativeElement.querySelector('[data-pairing]');
    if (block?.contains(this.doc.activeElement)) {
      this.afterRender(() => this.section()?.focusHeading());
    }
  }

  private afterRender(action: () => void): void {
    afterNextRender(action, { injector: this.injector });
  }
}
