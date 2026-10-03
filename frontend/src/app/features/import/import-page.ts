import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { CanLeave } from '../../core/guards';
import { PageHeader } from '../../shared/page-header';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { LinkButton } from '../../shared/ui/link-button';
import { ImportDoneStep } from './import-done-step';
import { ImportFileStep } from './import-file-step';
import { ImportMappingStep } from './import-mapping-step';
import { ImportPreviewStep } from './import-preview-step';
import { ImportProfilesStore } from './import-profiles.store';
import { ImportReviewStore } from './import-review.store';
import { ImportWizardStore, WIZARD_STEPS } from './import-wizard.store';

/**
 * The CSV import wizard (`/import`): File, Columns, Review and Done. The choices live in
 * `ImportWizardStore` and `ImportReviewStore`, which this page provides, so Back keeps them and
 * leaving the page lets the file go. Leaving in the middle (a file read, nothing imported) asks first
 * (`canLeaveGuard` on the route).
 */
@Component({
  selector: 'app-import-page',
  imports: [
    RouterLink,
    PageHeader,
    LinkButton,
    ImportFileStep,
    ImportMappingStep,
    ImportPreviewStep,
    ImportDoneStep,
  ],
  providers: [ImportProfilesStore, ImportWizardStore, ImportReviewStore],
  template: `
    <app-page-header
      title="Import CSV"
      subtitle="Bring in spendings from your bank's CSV file. You check every row before anything is stored."
    >
      <a appLinkButton size="sm" routerLink="/spendings">Back to spendings</a>
    </app-page-header>

    <div class="max-w-5xl space-y-4">
      <nav aria-label="Import progress">
        <ol class="flex flex-wrap items-center gap-x-4 gap-y-2">
          @for (step of steps; track step.id; let i = $index) {
            <li
              class="flex items-center gap-2"
              [attr.aria-current]="i === stepIndex() ? 'step' : null"
            >
              <span
                aria-hidden="true"
                class="grid size-7 shrink-0 place-items-center rounded-full border-2 text-xs font-semibold"
                [class]="
                  i < stepIndex()
                    ? 'border-accent bg-accent text-on-accent'
                    : i === stepIndex()
                      ? 'border-accent text-accent'
                      : 'border-line-strong text-muted'
                "
                >{{ i < stepIndex() ? '✓' : i + 1 }}</span
              >
              <span
                class="text-sm"
                [class]="
                  i === stepIndex() ? 'font-semibold text-ink' : 'sr-only text-muted sm:not-sr-only'
                "
                >{{ step.label }}</span
              >
              @if (i < stepIndex()) {
                <span class="sr-only">(done)</span>
              }
            </li>
          }
        </ol>
      </nav>
      <p class="text-sm text-muted">Step {{ stepIndex() + 1 }} of {{ steps.length }}</p>

      @switch (wizard.step()) {
        @case ('file') {
          <app-import-file-step />
        }
        @case ('mapping') {
          <app-import-mapping-step />
        }
        @case ('preview') {
          <app-import-preview-step />
        }
        @case ('done') {
          <app-import-done-step />
        }
      }
    </div>
  `,
})
export class ImportPage implements CanLeave {
  protected readonly wizard = inject(ImportWizardStore);
  private readonly confirm = inject(ConfirmService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly steps = WIZARD_STEPS;
  protected readonly stepIndex = computed(() =>
    this.steps.findIndex((step) => step.id === this.wizard.step()),
  );

  constructor() {
    // A new step is a new page of the form: focus its heading, so a keyboard or screen reader user
    // lands on it. Not for the first step, which the shell already focused with the page.
    let first = true;
    effect(() => {
      this.wizard.step();
      if (first) {
        first = false;
        return;
      }
      untracked(() =>
        afterNextRender(
          () => this.host.nativeElement.querySelector<HTMLElement>('h2[tabindex="-1"]')?.focus(),
          { injector: this.injector },
        ),
      );
    });
  }

  /** Whether the page may be left now. A file that was read and not imported is asked about. */
  canLeave(): boolean | Promise<boolean> {
    if (!this.wizard.hasWork()) return true;
    return this.confirm.confirm({
      title: 'Leave the import?',
      message:
        'Your file and the rows you ticked are kept only on this page. If you leave now, you start over. Nothing has been imported.',
      confirmLabel: 'Leave',
      cancelLabel: 'Stay',
    });
  }
}
