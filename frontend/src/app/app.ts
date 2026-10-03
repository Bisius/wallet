import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { activeRouteData, type AppRouteData } from './core/route-data';
import { SavingsStore } from './core/savings.store';
import { SelectedMonth } from './core/selected-month';
import { ThemeService } from './core/theme.service';
import { ApiStatusIndicator } from './shared/ui/api-status-indicator';
import { ConfirmDialog } from './shared/ui/confirm-dialog';
import { MonthSwitcher } from './shared/ui/month-switcher';
import { LoadingState } from './shared/ui/states';
import { ToastContainer } from './shared/ui/toast-container';

interface NavItem {
  path: string;
  label: string;
  /** Shows how many months wait to be moved to savings, next to the label. */
  savingsBadge?: boolean;
}

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MonthSwitcher,
    ApiStatusIndicator,
    ToastContainer,
    ConfirmDialog,
    LoadingState,
  ],
  templateUrl: './app.html',
})
export class App {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');

  protected readonly selectedMonth = inject(SelectedMonth);
  private readonly savings = inject(SavingsStore);

  /** The closed months waiting to be moved to savings: the badge on the Savings link. */
  protected readonly outstandingMonths = this.savings.outstandingCount;

  protected readonly nav: NavItem[] = [
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/budgets', label: 'Budgets' },
    { path: '/spendings', label: 'Spendings' },
    { path: '/subscriptions', label: 'Subscriptions' },
    { path: '/income', label: 'Income' },
    { path: '/savings', label: 'Savings', savingsBadge: true },
    { path: '/settings', label: 'Settings' },
  ];

  /** True until the first navigation has finished (the guards are still loading the settings). */
  protected readonly starting = signal(true);

  private readonly routeData = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => activeRouteData(this.router.routerState.snapshot.root)),
    ),
    { initialValue: {} as AppRouteData },
  );
  protected readonly showMonthSwitcher = computed(() => this.routeData().monthScoped === true);
  protected readonly focusLayout = computed(() => this.routeData().focusLayout === true);

  private lastPath: string | null = null;

  constructor() {
    // Applying the theme is a side effect of creating the service.
    inject(ThemeService);

    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (
        event instanceof NavigationEnd ||
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        this.starting.set(false);
      }
      if (event instanceof NavigationEnd && this.movedToAnotherPage(event.urlAfterRedirects)) {
        this.savings.refresh();
        this.focusPage();
      }
    });
  }

  /** The skip link: `href="#main"` would navigate (the page has a `<base href>`), so move focus by hand. */
  protected skipToContent(event: Event): void {
    event.preventDefault();
    this.main().nativeElement.focus();
  }

  /**
   * Whether a finished navigation went to another page (not the first one, and not a change of the
   * query only, which is what the month switcher does).
   */
  private movedToAnotherPage(url: string): boolean {
    const path = url.split(/[?#]/)[0];
    const moved = this.lastPath !== null && path !== this.lastPath;
    this.lastPath = path;
    return moved;
  }

  /**
   * After the user moves to another page, focus its heading: keyboard and screen reader users would
   * otherwise stay on the link they clicked, with no sign that anything happened.
   */
  private focusPage(): void {
    afterNextRender(
      () => {
        const main = this.main().nativeElement;
        const target = main.querySelector<HTMLElement>('h1') ?? main;
        target.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }
}
