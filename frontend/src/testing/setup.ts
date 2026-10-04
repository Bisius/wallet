import { TestBed } from '@angular/core/testing';

// A spec whose `afterEach` throws (for example `http.verify()` finding an open request) must not
// leave its TestBed behind: the next spec would then fail with "test module already instantiated",
// far from the real problem. Start every spec from a clean slate.
beforeEach(() => TestBed.resetTestingModule());

/**
 * Runs before every spec (angular.json: test.options.setupFiles). jsdom implements neither the
 * behavior of `<dialog>` nor `popover` nor `matchMedia` nor `scrollIntoView`, so this file adds just
 * enough of them for the components under test. It approximates the browser: the specs assert what a user
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
      // The browser gives focus back to what had it before the dialog opened, but only while the
      // dialog is still in the document. One that left it first (which is how a framework removes
      // the component of an open dialog, before its destroy hooks run) closes without giving
      // anything back, and focus stays on the page body. Chromium does exactly this.
      const opener = openers.get(this);
      if (this.isConnected && opener instanceof HTMLElement && opener.isConnected) opener.focus();
      this.dispatchEvent(new Event('close'));
    },
  },
});

// Escape on an open modal dialog: `cancel` (which can be prevented), then close. As in a browser, the
// key is the dialog's only when nothing inside it took it (a handler that prevents the default of the
// keydown keeps the dialog open), and it is the topmost modal, the last one opened, that gets it.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const modals = document.querySelectorAll<HTMLDialogElement>('dialog[data-modal][open]');
  const dialog = modals[modals.length - 1];
  if (!dialog) return;
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  if (!cancel.defaultPrevented) dialog.close();
});

// --- popover -------------------------------------------------------------------------------------

/*
 * jsdom has no `popover`: no `showPopover()`, no `popovertarget` buttons, no light dismiss. This is
 * the part of it that `app-action-menu` and its specs use, for `popover="auto"`:
 *
 *  - `showPopover()`, `hidePopover()` and `togglePopover()` (what is open carries `data-popover-open`),
 *    which fire `beforetoggle` at once and `toggle` in a microtask, as the browser does (both with
 *    `oldState` and `newState`);
 *  - the `:popover-open` rule of the browser's own style sheet: a popover that is not open is
 *    `display: none` (jsdom's sheet says so already), one that is open is shown, so
 *    `getComputedStyle` tells them apart;
 *  - the invoker: a click on a `popovertarget` button toggles its popover;
 *  - light dismiss on a click outside (the browser does it on pointerup, `element.click()` has none),
 *    and Escape, which closes the topmost popover before a modal dialog below it sees the key.
 *
 * Not here: popovers over popovers (nesting), `popover="manual"` and `"hint"`, the top layer, and
 * anchor positioning. `:popover-open` itself is not a selector jsdom knows, so specs ask
 * `data-popover-open` (see `testing/menu.ts`).
 */

/**
 * Installs the shim once per window. A worker can run many spec files in the same window, and this
 * file runs again for each of them: a second click handler would toggle a popover twice.
 */
function installPopoverShim(): void {
  // jsdom's own style sheet hides `[popover]:not(:popover-open)`, a selector it cannot match: every
  // popover stays hidden. This is the other half of the rule, for the attribute that stands for it.
  const popoverStyle = document.createElement('style');
  popoverStyle.textContent = '[popover][data-popover-open] { display: block; }';
  document.head.append(popoverStyle);

  /** What had focus when the popover was shown: where Escape and the close button hand it back. */
  const popoverPrevious = new WeakMap<HTMLElement, Element | null>();

  const isAutoPopover = (element: Element): element is HTMLElement =>
    element instanceof HTMLElement &&
    element.hasAttribute('popover') &&
    ['', 'auto'].includes(element.getAttribute('popover') ?? '');

  const openPopovers = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[popover][data-popover-open]')).filter(
      isAutoPopover,
    );

  function popoverEvent(
    type: 'beforetoggle' | 'toggle',
    oldState: string,
    newState: string,
  ): Event {
    return Object.assign(new Event(type, { cancelable: type === 'beforetoggle' }), {
      oldState,
      newState,
    });
  }

  function showPopover(this: HTMLElement): void {
    if (!isAutoPopover(this)) throw new DOMException('Not a popover', 'NotSupportedError');
    if (this.hasAttribute('data-popover-open')) return;
    // An auto popover closes the others that are not around it.
    for (const other of openPopovers()) if (!other.contains(this)) hidePopover.call(other, false);
    popoverPrevious.set(this, document.activeElement);
    this.dispatchEvent(popoverEvent('beforetoggle', 'closed', 'open'));
    this.setAttribute('data-popover-open', '');
    queueMicrotask(() => this.dispatchEvent(popoverEvent('toggle', 'closed', 'open')));
  }

  function hidePopover(this: HTMLElement, focusPrevious = true): void {
    if (!isAutoPopover(this) || !this.hasAttribute('data-popover-open')) return;
    this.dispatchEvent(popoverEvent('beforetoggle', 'open', 'closed'));
    // The browser puts focus back on what had it before the popover opened, but only when focus is
    // inside the popover: a click on another control keeps its own focus.
    const previous = popoverPrevious.get(this);
    const hadFocus = this.contains(document.activeElement);
    this.removeAttribute('data-popover-open');
    if (focusPrevious && hadFocus && previous instanceof HTMLElement && previous.isConnected) {
      previous.focus();
    }
    queueMicrotask(() => this.dispatchEvent(popoverEvent('toggle', 'open', 'closed')));
  }

  function togglePopover(this: HTMLElement, force?: boolean): boolean {
    const open = this.hasAttribute('data-popover-open');
    if (open && force !== true) hidePopover.call(this);
    else if (!open && force !== false) showPopover.call(this);
    return this.hasAttribute('data-popover-open');
  }

  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, writable: true, value: showPopover },
    hidePopover: { configurable: true, writable: true, value: hidePopover },
    togglePopover: { configurable: true, writable: true, value: togglePopover },
  });

  /** The button that invokes a popover (`popovertarget`), and the popover it names. */
  function invokerOf(
    target: EventTarget | null,
  ): { button: HTMLElement; popover: HTMLElement } | null {
    const button =
      target instanceof Element ? target.closest<HTMLElement>('[popovertarget]') : null;
    if (!button || button.hasAttribute('disabled')) return null;
    const popover = document.getElementById(button.getAttribute('popovertarget') ?? '');
    return popover && isAutoPopover(popover) ? { button, popover } : null;
  }

  document.addEventListener('click', (event) => {
    const invoker = invokerOf(event.target);
    const target = event.target instanceof Node ? event.target : null;
    // Light dismiss: a click outside every open popover, and outside the button that opens it.
    for (const popover of openPopovers()) {
      if (target && popover.contains(target)) continue;
      if (invoker?.popover === popover) continue;
      hidePopover.call(popover, false);
    }
    if (!invoker) return;
    const action = invoker.button.getAttribute('popovertargetaction') ?? 'toggle';
    if (action === 'show') showPopover.call(invoker.popover);
    else if (action === 'hide') hidePopover.call(invoker.popover);
    else togglePopover.call(invoker.popover);
  });

  // Capture phase, so that it runs before the `<dialog>` handler below and, like the browser, takes
  // the key: the first Escape closes the popover, the second the dialog that holds it.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const popovers = openPopovers();
      const topmost = popovers[popovers.length - 1];
      if (!topmost) return;
      event.preventDefault();
      hidePopover.call(topmost);
    },
    true,
  );
}

const shimmed = window as unknown as { __popoverShim?: boolean };
if (!shimmed.__popoverShim) {
  shimmed.__popoverShim = true;
  installPopoverShim();
}

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
