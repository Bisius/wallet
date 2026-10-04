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
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { activeRouteData, type AppRouteData } from './core/route-data';
import { SavingsStore } from './core/savings.store';
import { ThemeService } from './core/theme.service';
import { AddSpending, AddSpendingFab } from './shell/add-spending';
import { AddSpendingDialog } from './shell/add-spending-dialog';
import { Sidebar } from './shell/sidebar';
import { TabBar } from './shell/tab-bar';
import { TopBar } from './shell/top-bar';
import { ConfirmDialog } from './shared/ui/confirm-dialog';
import { LoadingState } from './shared/ui/states';
import { ToastContainer } from './shared/ui/toast-container';
import { UpdateNotice } from './shared/ui/update-notice';

/** The padding of the page, which every page has. */
const MAIN = 'flex-1 p-4 md:p-8';
/**
 * Below `md` the tab bar is fixed over the bottom of the window, and the floating "Add spending" button
 * over that: the page leaves room for both under its last content (`--tab-bar-height` and `--fab-zone`,
 * styles.css), and for the home indicator of a phone. A page without the button needs less.
 */
const MAIN_WITH_BAR_AND_BUTTON =
  'pb-[calc(var(--tab-bar-height)+var(--fab-zone)+env(safe-area-inset-bottom))]';
const MAIN_WITH_BAR = 'pb-[calc(var(--tab-bar-height)+1rem+env(safe-area-inset-bottom))]';

/**
 * The app shell: the skip link, the sidebar (wide screens) or the tab bar (phones), the sticky top
 * bar with the period switcher and "Add spending", and the `main` that the router fills.
 *
 * What the shell shows follows the route's `data` (`AppRouteData`): which period switcher the page
 * has, whether it is a focus layout, whether it has its own way to add a spending.
 */
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    Sidebar,
    TopBar,
    TabBar,
    AddSpendingFab,
    AddSpendingDialog,
    ToastContainer,
    ConfirmDialog,
    LoadingState,
    UpdateNotice,
  ],
  templateUrl: './app.html',
})
export class App {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private readonly savings = inject(SavingsStore);

  protected readonly addSpending = inject(AddSpending);

  /** True until the first navigation has finished (the guards are still loading the settings). */
  protected readonly starting = signal(true);

  private readonly routeData = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => activeRouteData(this.router.routerState.snapshot.root)),
    ),
    { initialValue: {} as AppRouteData },
  );
  protected readonly period = computed(() => this.routeData().period);
  protected readonly focusLayout = computed(() => this.routeData().focusLayout === true);
  /**
   * The global "Add spending" is offered once the app is up (before that it is not known whether this
   * is the onboarding), except in a focus layout and on a page with its own form.
   */
  protected readonly showAddSpending = computed(
    () => !this.starting() && !this.focusLayout() && this.routeData().hideAddSpending !== true,
  );
  protected readonly mainClass = computed(() => {
    if (this.focusLayout()) return MAIN;
    return `${MAIN} ${this.showAddSpending() ? MAIN_WITH_BAR_AND_BUTTON : MAIN_WITH_BAR}`;
  });

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
