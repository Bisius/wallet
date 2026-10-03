import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { ConfirmDialog } from './confirm-dialog';
import { ConfirmService } from './confirm.service';

@Component({
  selector: 'app-confirm-host',
  imports: [ConfirmDialog],
  template: `<button type="button" id="delete">Delete</button><app-confirm-dialog />`,
})
class ConfirmHost {}

describe('confirm dialog', () => {
  async function setup() {
    const fixture = await render(ConfirmHost);
    const service = TestBed.inject(ConfirmService);
    const element = fixture.nativeElement as HTMLElement;
    const dialog = element.querySelector('dialog') as HTMLDialogElement;
    const opener = element.querySelector('#delete') as HTMLButtonElement;
    opener.focus();
    const ask = async (options = {}) => {
      const answer = service.confirm({
        title: 'Delete this income?',
        message: 'It will be removed from October.',
        confirmLabel: 'Delete income',
        tone: 'danger',
        ...options,
      });
      await settle(fixture);
      return answer;
    };
    return { fixture, service, element, dialog, opener, ask };
  }

  it('is closed until somebody asks', async () => {
    const { dialog } = await setup();
    expect(dialog.open).toBe(false);
  });

  it('opens a modal dialog with the question, named and described for screen readers', async () => {
    const { dialog, ask } = await setup();

    void ask();
    await settle();

    expect(dialog.open).toBe(true);
    const heading = getByRole(dialog, 'heading', 'Delete this income?');
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    const message = dialog.querySelector(`#${dialog.getAttribute('aria-describedby')}`);
    expect(textOf(message as Element)).toBe('It will be removed from October.');
    expect(getByRole(dialog, 'button', 'Delete income')).toBeTruthy();
    expect(getByRole(dialog, 'button', 'Cancel')).toBeTruthy();
  });

  it('puts focus on Cancel, so a stray Enter never confirms a deletion', async () => {
    const { dialog, ask } = await setup();

    void ask();
    await settle();

    expect(document.activeElement).toBe(getByRole(dialog, 'button', 'Cancel'));
  });

  it('answers true when confirmed, closes, and gives focus back', async () => {
    const { dialog, opener, ask } = await setup();

    const answer = ask();
    await settle();
    getByRole(dialog, 'button', 'Delete income').click();

    expect(await answer).toBe(true);
    await settle();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('answers false when cancelled', async () => {
    const { dialog, ask } = await setup();

    const answer = ask();
    await settle();
    getByRole(dialog, 'button', 'Cancel').click();

    expect(await answer).toBe(false);
    await settle();
    expect(dialog.open).toBe(false);
  });

  it('answers false on Escape', async () => {
    const { dialog, opener, ask } = await setup();

    const answer = ask();
    await settle();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(await answer).toBe(false);
    await settle();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('answers false on a click on the backdrop, not on a click inside the dialog', async () => {
    const { dialog, ask } = await setup();

    const answer = ask();
    await settle();
    getByRole(dialog, 'heading', 'Delete this income?').click();
    await settle();
    expect(dialog.open).toBe(true);

    dialog.click();
    expect(await answer).toBe(false);
  });

  it('uses a primary button for ordinary questions and a danger one for destructive ones', async () => {
    const { dialog, ask } = await setup();

    void ask({ tone: 'default', confirmLabel: 'Continue' });
    await settle();
    expect(getByRole(dialog, 'button', 'Continue').className).toContain('bg-accent');

    getByRole(dialog, 'button', 'Cancel').click();
    await settle();

    void ask({ tone: 'danger', confirmLabel: 'Delete' });
    await settle();
    expect(getByRole(dialog, 'button', 'Delete').className).toContain('bg-negative');
  });

  it('counts a new question that replaces an open one as "no" for the first', async () => {
    const { service, dialog, ask } = await setup();

    const first = ask({ title: 'First?' });
    await settle();
    const second = service.confirm({ title: 'Second?', message: 'Sure?' });
    await settle();

    expect(await first).toBe(false);
    expect(getByRole(dialog, 'heading', 'Second?')).toBeTruthy();
    getByRole(dialog, 'button', 'Confirm').click();
    expect(await second).toBe(true);
  });

  it('has no content while closed', async () => {
    const { dialog, ask } = await setup();
    expect(queryByRole(dialog, 'button')).toBeNull();

    const answer = ask();
    await settle();
    getByRole(dialog, 'button', 'Cancel').click();
    await answer;
    await settle();

    expect(queryByRole(dialog, 'button')).toBeNull();
  });
});
