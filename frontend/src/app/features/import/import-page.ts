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
import { ConfirmService } from '../../shared/ui/confirm.service';
import { LinkButton } from '../../shared/ui/link-button';
import { AppPage, type PageWidth } from '../../shared/ui/page';
import { PageHeader } from '../../shared/ui/page-header';
import { Stepper } from '../../shared/ui/stepper';
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
    AppPage,
    PageHeader,
    LinkButton,
    Stepper,
    ImportFileStep,
    ImportMappingStep,
    ImportPreviewStep,
    ImportDoneStep,
  ],
  providers: [ImportProfilesStore, ImportWizardStore, ImportReviewStore],
  template: `
    <app-page [width]="width()">
      <app-page-header title="Import CSV" subtitle="Bring in spendings from your bank's CSV file.">
        <a appLinkButton size="sm" routerLink="/spendings">Back to spendings</a>
      </app-page-header>

      <app-stepper label="Import progress" [steps]="steps" [current]="stepIndex()" />

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
    </app-page>
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
  /** The mapping and the review are tables and wide forms; choosing a file and the result are a column. */
  protected readonly width = computed<PageWidth>(() => {
    const step = this.wizard.step();
    return step === 'mapping' || step === 'preview' ? 'wide' : 'narrow';
  });

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
