import { TestBed } from '@angular/core/testing';

// A spec whose `afterEach` throws (for example `http.verify()` finding an open request) must not
// leave its TestBed behind: the next spec would then fail with "test module already instantiated",
// far from the real problem. Start every spec from a clean slate.
beforeEach(() => TestBed.resetTestingModule());

/**
 * Runs before every spec (angular.json: test.options.setupFiles). jsdom implements neither the
 * behavior of `<dialog>` nor `matchMedia` nor `scrollIntoView`, so this file adds just enough of
 * them for the components under test. It approximates the browser: the specs assert what a user
 * would see, and the real behavior was checked in Chromium.
 */

// --- <dialog> ------------------------------------------------------------------------------------

const openers = new WeakMap<HTMLDialogElement, Element | null>();

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement): void {
      if (this.hasAttribute('open')) throw new DOMException('Already open', 'InvalidStateError');
      openers.set(this, document.activeElement);
      this.setAttribute('open', '');
      this.setAttribute('data-modal', '');
      // The dialog focusing steps: the element marked autofocus, else the first focusable one.
      const target =
        this.querySelector<HTMLElement>('[autofocus]') ??
        this.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    },
  },
  show: {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    },
  },
  close: {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement, returnValue?: string): void {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.removeAttribute('data-modal');
      if (returnValue !== undefined) (this as { returnValue: string }).returnValue = returnValue;
      // The browser gives focus back to what had it before the dialog opened.
      const opener = openers.get(this);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      this.dispatchEvent(new Event('close'));
    },
  },
});

// Escape on an open modal dialog: `cancel` (which can be prevented), then close.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-modal][open]');
  if (!dialog) return;
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  if (!cancel.defaultPrevented) dialog.close();
});

// --- matchMedia and scrolling --------------------------------------------------------------------

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}
