import { Component, signal } from '@angular/core';
import { getByLabel, getByRole, queryByRole } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { AppDialog } from './dialog';

@Component({
  selector: 'app-dialog-host',
  imports: [AppDialog],
  template: `
    <button type="button" id="opener" (click)="open.set(true)">Open</button>
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
