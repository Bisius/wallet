import { TestBed } from '@angular/core/testing';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { ToastContainer } from './toast-container';
import { TOAST_ACTION_DURATION_MS, TOAST_DURATION_MS, ToastService } from './toast.service';

describe('toasts', () => {
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const fixture = await render(ToastContainer);
    const toasts = TestBed.inject(ToastService);
    const element = fixture.nativeElement as HTMLElement;
    return { fixture, toasts, element };
  }

  it('sits at the bottom of the window, above the tab bar of a phone when told there is one', async () => {
    const { fixture, element } = await setup();
    const box = () => element.querySelector('.fixed') as HTMLElement;
    expect(box().className).toContain('bottom-0');
    expect(box().className).not.toContain('--tab-bar-height');

    fixture.componentRef.setInput('aboveTabBar', true);
    await settle(fixture);

    // Below `md`, above the tab bar and the floating button over it; from `md` up, as before.
    expect(box().className).toContain('max-md:pb-[calc(var(--tab-bar-height)+var(--fab-zone)');
    expect(box().className).toContain('pb-[max(1rem,env(safe-area-inset-bottom))]');
  });

  it('always has both live regions in the page, so what is added to them is announced', async () => {
    const { element } = await setup();

    expect(getByRole(element, 'status')).toBeTruthy();
    expect(getByRole(element, 'alert')).toBeTruthy();
    expect(textOf(element)).toBe('');
  });

  it('shows success and info messages in the polite region', async () => {
    const { fixture, toasts, element } = await setup();

    toasts.success('Settings saved.');
    toasts.info('Something to know.');
    await settle(fixture);

    const status = getByRole(element, 'status');
    expect(textOf(status)).toContain('Settings saved.');
    expect(textOf(status)).toContain('Something to know.');
    expect(textOf(getByRole(element, 'alert'))).toBe('');
  });

  it('shows errors in the assertive region, labelled so they are not just a color', async () => {
    const { fixture, toasts, element } = await setup();

    toasts.error('The server ran into a problem.');
    await settle(fixture);

    expect(textOf(getByRole(element, 'alert'))).toBe('Error: The server ran into a problem.');
    expect(textOf(getByRole(element, 'status'))).toBe('');
  });

  it('dismisses success toasts by itself, but keeps errors until they are dismissed', async () => {
    const { fixture, toasts, element } = await setup();
    // Fake timers only after rendering: settle() itself waits on a real timer.
    vi.useFakeTimers();

    toasts.success('Saved.');
    toasts.error('Could not delete.');
    await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS + 100);
    TestBed.tick();
    fixture.detectChanges();

    expect(textOf(element)).not.toContain('Saved.');
    expect(textOf(element)).toContain('Could not delete.');
  });

  it('can be dismissed with its button', async () => {
    const { fixture, toasts, element } = await setup();
    toasts.error('Could not delete.');
    await settle(fixture);

    getByRole(element, 'button', 'Dismiss error').click();
    await settle(fixture);

    expect(queryByRole(element, 'button', 'Dismiss error')).toBeNull();
    expect(textOf(element)).toBe('');
  });

  it('shows at most a few at once, dropping the oldest', async () => {
    const { fixture, toasts, element } = await setup();

    for (let i = 1; i <= 6; i++) toasts.success(`Message ${i}`);
    await settle(fixture);

    const text = textOf(element);
    expect(text).not.toContain('Message 1');
    expect(text).not.toContain('Message 2');
    expect(text).toContain('Message 6');
  });

  describe('with an action', () => {
    it('shows a button after the message that runs the action and dismisses the toast', async () => {
      const { fixture, toasts, element } = await setup();
      const undo = vi.fn();

      toasts.success('September 2026 moved to savings.', { label: 'Undo', run: undo });
      await settle(fixture);
      expect(textOf(getByRole(element, 'status'))).toContain('September 2026 moved to savings.');

      getByRole(element, 'button', 'Undo').click();
      await settle(fixture);

      expect(undo).toHaveBeenCalledTimes(1);
      expect(textOf(element)).toBe('');
      expect(toasts.toasts()).toEqual([]);
    });

    it('stays longer than a plain toast, so there is time to press it', async () => {
      const { fixture, toasts, element } = await setup();
      vi.useFakeTimers();

      toasts.success('Plain.');
      toasts.info('With an action.', { label: 'Undo', run: () => undefined });
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS + 100);
      TestBed.tick();
      fixture.detectChanges();

      expect(textOf(element)).not.toContain('Plain.');
      expect(textOf(element)).toContain('With an action.');

      await vi.advanceTimersByTimeAsync(TOAST_ACTION_DURATION_MS);
      TestBed.tick();
      fixture.detectChanges();
      expect(textOf(element)).not.toContain('With an action.');
    });

    it('does nothing for a toast that is already gone', () => {
      const toasts = TestBed.inject(ToastService);
      expect(() => toasts.act(999)).not.toThrow();
    });
  });
});
