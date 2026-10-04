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
import { ActionMenu, MenuItem } from '../../shared/ui/action-menu';
import { AsyncSection } from '../../shared/ui/async-section';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { AppList, ListRow } from '../../shared/ui/list';
import { SectionHelp } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';
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
  imports: [
    ActionMenu,
    AppList,
    AsyncSection,
    EmptyState,
    Icon,
    ListRow,
    MenuItem,
    SectionHelp,
    TagChip,
    TagForm,
  ],
  template: `
    <app-async-section
      heading="Tags"
      description="Labels you put on spendings to find them later."
      focusable
      [state]="store.state()"
      [error]="store.error()"
      loadingLabel="Loading tags…"
      errorTitle="Couldn't load the tags"
      (retry)="store.reload()"
    >
      <p sectionHelp>
        A tag never changes a budget or a balance. You create tags while you add or edit a spending.
      </p>
      @if (store.tags().length === 0) {
        <app-empty-state
          title="No tags yet"
          description="Add a tag to a spending and it will be listed here."
        />
      } @else {
        <ul appList>
          @for (tag of store.tags(); track tag.id) {
            <li appListRow [titleLabel]="'Edit tag ' + tag.name" (titleClick)="edit(tag)">
              <span rowTitle><app-tag-chip [name]="tag.name" [color]="tag.color" /></span>
              <p rowMeta>
                <span>{{ colorName(tag) }} · {{ usageText(tag) }}</span>
              </p>
              <app-action-menu
                rowActions
                [attr.data-menu]="tag.id"
                [label]="'More actions for tag ' + tag.name"
              >
                <button appMenuItem [disabled]="busy()" (click)="edit(tag)">
                  <app-icon name="pencil" />
                  Edit
                </button>
                <button appMenuItem destructive [disabled]="busy()" (click)="remove(tag)">
                  <app-icon name="trash" />
                  Delete
                </button>
              </app-action-menu>
            </li>
          }
        </ul>
      }
    </app-async-section>

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
  private readonly section = viewChild(AsyncSection);

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

  protected edit(tag: TagDto): void {
    if (!this.busy()) this.editing.set(tag);
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
    // failed the row is still there, and focus goes back to the button of its menu.
    afterNextRender(
      () =>
        gone
          ? this.section()?.focusHeading()
          : this.host.nativeElement
              .querySelector<HTMLElement>(`[data-menu="${tag.id}"] button`)
              ?.focus(),
      { injector: this.injector },
    );
  }
}
