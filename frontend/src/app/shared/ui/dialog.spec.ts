import { Component, signal } from '@angular/core';
import { getByLabel, getByRole, queryByRole } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { AppDialog } from './dialog';

@Component({
  selector: 'app-dialog-host',
  imports: [AppDialog],
  template: `
    @if (showOpener()) {
      <button type="button" id="opener" (click)="open.set(true)">Open</button>
    }
    <button type="button" id="other">Somewhere else</button>
    @if (open()) {
      <app-dialog heading="New budget" [locked]="locked()" (closed)="onClosed()">
        <label for="name">Name</label>
        <input id="name" />
        <button type="button" (click)="open.set(false)">Cancel</button>
      </app-dialog>
    }
  `,
})
class DialogHost {
  readonly open = signal(false);
  readonly locked = signal(false);
  readonly showOpener = signal(true);
  closedEvents = 0;

  onClosed(): void {
    this.closedEvents++;
    this.open.set(false);
  }
}

@Component({
  selector: 'app-autofocus-host',
  imports: [AppDialog],
  template: `
    <button type="button" id="opener" (click)="open.set(true)">Open</button>
    @if (open()) {
      <app-dialog heading="Pick one">
        <label for="name">Name</label>
        <input id="name" />
        <label for="nickname">Nickname</label>
        <input id="nickname" autofocus />
      </app-dialog>
    }
  `,
})
class AutofocusHost {
  readonly open = signal(false);
}

@Component({
  selector: 'app-sheet-host',
  imports: [AppDialog],
  template: `
    <button type="button" id="opener" (click)="open.set(true)">More</button>
    @if (open()) {
      <app-dialog heading="More" variant="sheet" (closed)="open.set(false)">
        <a href="/income" id="first">Income</a>
        <a href="/report">Report</a>
      </app-dialog>
    }
  `,
})
class SheetHost {
  readonly open = signal(false);
}

describe('AppDialog as a sheet', () => {
  async function setup() {
    const fixture = await render(SheetHost);
    const element = fixture.nativeElement as HTMLElement;
    const opener = element.querySelector('#opener') as HTMLButtonElement;
    const show = async () => {
      opener.focus();
      opener.click();
      await settle(fixture);
    };
    const dialog = () => element.querySelector('dialog') as HTMLDialogElement | null;
    return { fixture, element, opener, show, dialog };
  }

  it('is a modal dialog named by its heading, marked as a sheet', async () => {
    const { element, show, dialog } = await setup();
    await show();

    expect(dialog()?.open).toBe(true);
    expect(dialog()?.getAttribute('data-variant')).toBe('sheet');
    expect(getByRole(element, 'dialog', 'More')).toBe(dialog());
  });

  it('sits on the bottom edge, takes the whole width, slides in and keeps clear of the home indicator', async () => {
    const { show, dialog } = await setup();
    await show();

    const classes = dialog()?.className ?? '';
    for (const name of [
      'mt-auto',
      'mb-0',
      'w-full',
      'max-w-none',
      'rounded-t-card',
      'rounded-b-none',
      'bg-surface-raised',
      'motion-safe:animate-sheet-in',
      'backdrop:bg-black/60',
    ]) {
      expect(classes, name).toContain(name);
    }
    expect(classes).not.toContain('m-auto');
    expect(dialog()?.querySelector('[class*="safe-area-inset-bottom"]')).not.toBeNull();
  });

  it('puts focus on its first link, and gives it back to what opened it on Escape', async () => {
    const { fixture, opener, show, dialog } = await setup();
    await show();
    expect(document.activeElement?.id).toBe('first');

    dialog()?.close();
    await settle(fixture);

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a tap on the backdrop, which is a click on the dialog itself', async () => {
    const { fixture, opener, show, dialog } = await setup();
    await show();

    dialog()?.click();
    await settle(fixture);

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('stays open for a tap on what is inside it', async () => {
    const { fixture, element, show, dialog } = await setup();
    await show();

    getByRole(element, 'heading', 'More').click();
    await settle(fixture);

    expect(dialog()?.open).toBe(true);
  });

  it('is the dialog of a form by default: centered, and not closed by a tap outside', async () => {
    const fixture = await render(DialogHost);
    const element = fixture.nativeElement as HTMLElement;
    (element.querySelector('#opener') as HTMLButtonElement).click();
    await settle(fixture);

    const dialog = element.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.getAttribute('data-variant')).toBe('dialog');
    expect(dialog.className).toContain('m-auto');
    expect(dialog.className).not.toContain('animate-sheet-in');
  });
});

describe('AppDialog', () => {
  async function setup() {
    const fixture = await render(DialogHost);
    const element = fixture.nativeElement as HTMLElement;
    const opener = element.querySelector('#opener') as HTMLButtonElement;
    const host = fixture.componentInstance;
    const show = async () => {
      opener.focus();
      opener.click();
      await settle(fixture);
    };
    const dialog = () => element.querySelector('dialog') as HTMLDialogElement | null;
    return { fixture, element, opener, host, show, dialog };
  }

  it('is not in the page until it is asked for', async () => {
    const { dialog } = await setup();
    expect(dialog()).toBeNull();
  });

  it('opens as a modal, named by its heading', async () => {
    const { element, show, dialog } = await setup();
    await show();

    expect(dialog()?.open).toBe(true);
    const heading = getByRole(element, 'heading', 'New budget');
    expect(dialog()?.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(getByRole(element, 'dialog', 'New budget')).toBe(dialog());
  });

  it('puts focus on the first field', async () => {
    const { element, show } = await setup();
    await show();

    expect(document.activeElement).toBe(getByLabel(element, 'Name'));
  });

  it('names the first field as the one to focus, so a tall, scrolling form does not take the focus itself', async () => {
    const { element, show } = await setup();
    await show();

    expect(getByLabel(element, 'Name').hasAttribute('autofocus')).toBe(true);
    expect(getByRole(element, 'button', 'Cancel').hasAttribute('autofocus')).toBe(false);
  });

  it('leaves an autofocus that the content chose alone', async () => {
    const fixture = await render(AutofocusHost);
    const element = fixture.nativeElement as HTMLElement;
    (element.querySelector('#opener') as HTMLButtonElement).click();
    await settle(fixture);

    expect(getByLabel(element, 'Name').hasAttribute('autofocus')).toBe(false);
    expect(getByLabel(element, 'Nickname').hasAttribute('autofocus')).toBe(true);
    expect(document.activeElement).toBe(getByLabel(element, 'Nickname'));
  });

  it('closes on Escape, tells its owner, and gives focus back to what opened it', async () => {
    const { fixture, host, opener, show, dialog } = await setup();
    await show();

    dialog()?.close();
    await settle(fixture);

    expect(host.closedEvents).toBe(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does nothing on Escape while it is locked, so a save in flight is not lost', async () => {
    const { fixture, host, show, dialog } = await setup();
    await show();
    host.locked.set(true);
    await settle(fixture);

    const cancel = new Event('cancel', { cancelable: true });
    dialog()?.dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog()?.open).toBe(true);

    host.locked.set(false);
    await settle(fixture);
    const again = new Event('cancel', { cancelable: true });
    dialog()?.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });

  it('does not close on a click outside it, so a stray tap keeps a half-filled form', async () => {
    const { fixture, host, show, dialog } = await setup();
    await show();

    dialog()?.click();
    await settle(fixture);

    expect(host.closedEvents).toBe(0);
    expect(dialog()?.open).toBe(true);
  });

  it('closes when its owner removes it, and then gives focus back, without a "closed" event', async () => {
    const { fixture, element, host, opener, show } = await setup();
    await show();

    getByRole(element, 'button', 'Cancel').click();
    await settle(fixture);

    expect(queryByRole(element, 'dialog')).toBeNull();
    expect(host.closedEvents).toBe(0);
    expect(document.activeElement).toBe(opener);
  });

  it('gives focus back to what opened it when the owner removes it after a Save, not only on Cancel', async () => {
    // Real browsers close a dialog that has left the document without giving focus back (it falls to the
    // page body): the dialog has to do it by hand. The specs' <dialog> behaves the same way.
    const { fixture, element, opener, show, dialog } = await setup();
    await show();
    expect(document.activeElement).not.toBe(opener);

    getByRole(element, 'button', 'Cancel').click();
    await settle(fixture);

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone when something else has it by then', async () => {
    const { fixture, element, show } = await setup();
    await show();
    const other = element.querySelector('#other') as HTMLButtonElement;
    other.focus();

    getByRole(element, 'button', 'Cancel').click();
    await settle(fixture);

    expect(document.activeElement).toBe(other);
  });

  it('does not fail when what opened it is gone', async () => {
    const { fixture, element, host, show, dialog } = await setup();
    await show();
    host.showOpener.set(false);
    await settle(fixture);

    getByRole(element, 'button', 'Cancel').click();
    await settle(fixture);

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('can be opened again', async () => {
    const { fixture, element, host, show, dialog } = await setup();
    await show();
    getByRole(element, 'button', 'Cancel').click();
    await settle(fixture);

    host.open.set(true);
    await settle(fixture);

    expect(dialog()?.open).toBe(true);
  });
});
