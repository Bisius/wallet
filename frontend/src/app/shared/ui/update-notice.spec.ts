import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type VersionEvent, SwUpdate } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { getByRole, queryByRole, textOf } from '../../../testing/dom';
import { render, settle } from '../../../testing/harness';
import { RELOAD_PAGE } from '../../core/app-update';
import { UpdateNotice } from './update-notice';

const READY = {
  type: 'VERSION_READY',
  currentVersion: { hash: 'old' },
  latestVersion: { hash: 'new' },
} as VersionEvent;

describe('UpdateNotice', () => {
  let versionUpdates: Subject<VersionEvent>;
  let unrecoverable: Subject<{ type: 'UNRECOVERABLE_STATE'; reason: string }>;
  let sw: {
    isEnabled: boolean;
    versionUpdates: Subject<VersionEvent>;
    unrecoverable: Subject<{ type: 'UNRECOVERABLE_STATE'; reason: string }>;
    checkForUpdate: ReturnType<typeof vi.fn>;
    activateUpdate: ReturnType<typeof vi.fn>;
  };
  let reloadPage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    versionUpdates = new Subject();
    unrecoverable = new Subject();
    sw = {
      isEnabled: true,
      versionUpdates,
      unrecoverable,
      checkForUpdate: vi.fn(() => Promise.resolve(false)),
      activateUpdate: vi.fn(() => Promise.resolve(true)),
    };
    reloadPage = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: SwUpdate, useValue: sw },
        { provide: RELOAD_PAGE, useValue: reloadPage },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('says nothing until a new version is ready', async () => {
    const fixture = await render(UpdateNotice);

    expect(textOf(fixture.nativeElement)).toBe('');
    expect(queryByRole(fixture.nativeElement, 'button', /Reload/)).toBeNull();
  });

  it('says so, and offers the reload, when the worker has a new version', async () => {
    const fixture = await render(UpdateNotice);

    versionUpdates.next(READY);
    await settle(fixture);

    expect(textOf(fixture.nativeElement)).toContain('A new version is ready.');
    expect(getByRole(fixture.nativeElement, 'button', 'Reload to update')).toBeTruthy();
    // Announced politely, not as an alert: it is no error.
    expect(fixture.nativeElement.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it('ignores the other news of the worker', async () => {
    const fixture = await render(UpdateNotice);

    versionUpdates.next({ type: 'NO_NEW_VERSION_DETECTED', version: { hash: 'old' } });
    versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'new' } });
    await settle(fixture);

    expect(textOf(fixture.nativeElement)).toBe('');
  });

  it('also offers it when the worker cannot repair itself', async () => {
    const fixture = await render(UpdateNotice);

    unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'hash mismatch' });
    await settle(fixture);

    expect(getByRole(fixture.nativeElement, 'button', 'Reload to update')).toBeTruthy();
  });

  it('switches to the new version, then reloads, when the button is pressed', async () => {
    const fixture = await render(UpdateNotice);
    versionUpdates.next(READY);
    await settle(fixture);

    getByRole(fixture.nativeElement, 'button', 'Reload to update').click();
    await settle(fixture);

    expect(sw.activateUpdate).toHaveBeenCalledOnce();
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(sw.activateUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      reloadPage.mock.invocationCallOrder[0],
    );
  });

  it('reloads even when the worker refuses to switch', async () => {
    sw.activateUpdate.mockRejectedValue(new Error('no worker'));
    const fixture = await render(UpdateNotice);
    versionUpdates.next(READY);
    await settle(fixture);

    getByRole(fixture.nativeElement, 'button', 'Reload to update').click();
    await settle(fixture);

    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('looks for a new version when the app comes back to the foreground, not when it leaves', async () => {
    await render(UpdateNotice);
    const doc = TestBed.inject(DOCUMENT);
    const hidden = vi.spyOn(doc, 'hidden', 'get');

    hidden.mockReturnValue(true);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checkForUpdate).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checkForUpdate).toHaveBeenCalledOnce();
  });

  it('does nothing without a service worker (ng serve, tests, a browser that has none)', async () => {
    TestBed.resetTestingModule();
    sw.isEnabled = false;
    TestBed.configureTestingModule({ providers: [{ provide: SwUpdate, useValue: sw }] });
    const fixture = await render(UpdateNotice);

    versionUpdates.next(READY);
    TestBed.inject(DOCUMENT).dispatchEvent(new Event('visibilitychange'));
    await settle(fixture);

    expect(textOf(fixture.nativeElement)).toBe('');
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when the app was not set up with a service worker at all', async () => {
    TestBed.resetTestingModule();
    const fixture = await render(UpdateNotice);

    expect(textOf(fixture.nativeElement)).toBe('');
  });
});
