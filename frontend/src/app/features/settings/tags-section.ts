import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import type { TagDto } from '@wallet/shared';
import { parseApiError } from '../../core/api-error';
import { TagsStore } from '../../core/tags.store';
import { COLOR_SWATCHES } from '../../shared/forms/color-picker';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { TagChip } from '../../shared/ui/tag-chip';
import { ToastService } from '../../shared/ui/toast.service';
import { TagForm } from './tag-form';

/** How many spendings carry a tag, in words. */
function usage(count: number): string {
  return count === 1 ? 'On 1 spending' : `On ${count} spendings`;
}

/**
 * The tags (`GET /api/tags`, through `TagsStore`): each with its color, in words as well as in color,
 * and how many spendings carry it. A tag can be renamed, recolored or have its color cleared (`TagForm`)
 * and deleted. Deleting asks first and says how many spendings lose the tag, and that they stay.
 *
 * Tags are made where they are used, in the tag field of a spending, so there is no "new tag" here.
 * A tag never changes a budget or a balance: it only helps to find spendings.
 */
@Component({
  selector: 'app-tags-section',
  imports: [Button, EmptyState, ErrorState, Icon, LoadingState, TagChip, TagForm],
  template: `
    <section aria-labelledby="tags-heading" class="card space-y-4">
      <div>
        <h2 #heading id="tags-heading" tabindex="-1" class="text-lg font-semibold">Tags</h2>
        <p class="mt-1 text-sm text-muted">
          Labels you put on spendings to find them later. A tag never changes a budget or a balance.
          You create tags while you add or edit a spending.
        </p>
      </div>

      @switch (store.state()) {
        @case ('loading') {
          <app-loading-state label="Loading tags…" />
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load the tags"
            [error]="store.error()"
            (retry)="store.reload()"
          />
        }
        @default {
          @if (store.tags().length === 0) {
            <app-empty-state
              title="No tags yet"
              description="Add a tag to a spending and it will be listed here."
            />
          } @else {
            <ul class="divide-y divide-line rounded-card border border-line">
              @for (tag of store.tags(); track tag.id) {
                <li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
                  <div class="min-w-0 flex-1">
                    <p><app-tag-chip [name]="tag.name" [color]="tag.color" /></p>
                    <p class="mt-1 text-sm text-muted">
                      {{ colorName(tag) }} · {{ usageText(tag) }}
                    </p>
                  </div>
                  <div class="flex gap-1">
                    <button
                      appButton
                      variant="ghost"
                      size="sm"
                      [attr.aria-label]="'Edit tag ' + tag.name"
                      [attr.data-action]="'edit-tag-' + tag.id"
                      [disabled]="busy()"
                      (click)="editing.set(tag)"
                    >
                      <app-icon name="pencil" />
                      Edit
                    </button>
                    <button
                      appButton
                      variant="ghost"
                      size="sm"
                      [attr.aria-label]="'Delete tag ' + tag.name"
                      [attr.data-action]="'delete-tag-' + tag.id"
                      [disabled]="busy()"
                      (click)="remove(tag)"
                    >
                      <app-icon name="trash" />
                      Delete
                    </button>
                  </div>
                </li>
              }
            </ul>
          }
        }
      }
    </section>

    @if (editing(); as tag) {
      <app-tag-form [tag]="tag" (finished)="editing.set(null)" (cancelled)="editing.set(null)" />
    }
  `,
  host: { class: 'block' },
})
export class TagsSection {
  protected readonly store = inject(TagsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  /** The tag being edited in the dialog. */
  protected readonly editing = signal<TagDto | null>(null);
  /** A delete is out. */
  protected readonly busy = signal(false);

  constructor() {
    // How many spendings carry a tag changes whenever a spending does, away from this page: show
    // the list as it is now. (A visit that is also the first one is already loading it.)
    this.store.refresh();
  }

  /** The color of a tag in words: its name in the palette, else the code, else "No color". */
  protected colorName(tag: TagDto): string {
    if (tag.color === null) return 'No color';
    return COLOR_SWATCHES.find((swatch) => swatch.value === tag.color)?.name ?? tag.color;
  }

  protected usageText(tag: TagDto): string {
    return usage(tag.usageCount);
  }

  protected async remove(tag: TagDto): Promise<void> {
    if (this.busy()) return;
    const lose =
      tag.usageCount === 0
        ? `"${tag.name}" is not on any spending, so nothing else changes.`
        : `"${tag.name}" is on ${tag.usageCount} ${tag.usageCount === 1 ? 'spending' : 'spendings'}. ` +
          `${tag.usageCount === 1 ? 'It loses' : 'They lose'} the tag and ` +
          `${tag.usageCount === 1 ? 'stays' : 'stay'} exactly as ${tag.usageCount === 1 ? 'it is' : 'they are'}: ` +
          `no amount, date or budget changes.`;
    const confirmed = await this.confirm.confirm({
      title: `Delete the tag "${tag.name}"?`,
      message: lose,
      confirmLabel: 'Delete tag',
      tone: 'danger',
    });
    if (!confirmed) return;

    this.busy.set(true);
    let gone = false;
    try {
      await this.store.remove(tag.id);
      this.toast.success(`Tag ${tag.name} deleted.`);
      gone = true;
    } catch (error) {
      const parsed = parseApiError(error);
      if (parsed.code === 'not_found') {
        this.toast.info('That tag was already gone.');
        await this.store.reload();
        gone = true;
      } else {
        this.toast.error(`Couldn't delete the tag. ${parsed.message}`);
      }
    } finally {
      this.busy.set(false);
    }
    // The row that had focus is gone, so the heading is where the keyboard goes. When the delete
    // failed the row is still there: its button was disabled while the request was out, which took
    // focus away, so it gets focus back.
    afterNextRender(
      () =>
        gone
          ? this.heading()?.nativeElement.focus()
          : this.host.nativeElement
              .querySelector<HTMLElement>(`[data-action="delete-tag-${tag.id}"]`)
              ?.focus(),
      { injector: this.injector },
    );
  }
}
