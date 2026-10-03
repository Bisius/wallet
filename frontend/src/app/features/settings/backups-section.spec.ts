import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { BackupsDto } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import { backupDto, backupsDto } from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { ToastService } from '../../shared/ui/toast.service';
import { BackupsSection } from './backups-section';

/** What a person in any time zone reads for an instant: the same formatter the section uses. */
const when = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

const NEWEST = backupDto({
  name: 'wallet-20261003-142530.db',
  createdAt: '2026-10-03T14:25:30.000Z',
  sizeBytes: 1536,
});
const OLDER = backupDto({
  name: 'wallet-20261002-142530.db',
  createdAt: '2026-10-02T14:25:30.000Z',
  sizeBytes: 12.3 * 1048576,
});
const ON: BackupsDto = backupsDto({
  backups: [NEWEST, OLDER],
  lastBackupAt: '2026-10-03T14:25:30.000Z',
  nextDueAt: '2026-10-04T14:25:30.000Z',
});

describe('BackupsSection', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup(answer: BackupsDto | 'loading' | 'error' = ON) {
    await primeStores(http);
    const fixture = TestBed.createComponent(BackupsSection);
    fixture.detectChanges();
    await settle(fixture);
    const request = http.expectOne('/api/backups');
    if (answer === 'error') flushError(request, 500, 'internal_error', 'No backup folder access');
    else if (answer !== 'loading') request.flush(answer);
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      element,
      section: () => getByRole(element, 'region', 'Backups'),
      button: () => getByRole(element, 'button', 'Back up now') as HTMLButtonElement,
      rows: () =>
        queryAllByRole(getByRole(element, 'list', 'Backups, newest first'), 'listitem').map(textOf),
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      press: async () => {
        getByRole(element, 'button', 'Back up now').click();
        await settle(fixture);
      },
    };
  }

  it('says it is loading', async () => {
    const t = await setup('loading');

    expect(textOf(t.section())).toContain('Loading backups…');
    expect(queryByRole(t.element, 'button', 'Back up now')).toBeNull();
  });

  it('says what went wrong when the backups cannot be loaded, and tries again', async () => {
    const t = await setup('error');

    const alert = getByRole(t.element, 'alert');
    expect(textOf(alert)).toContain("Couldn't load the backups");
    expect(textOf(alert)).toContain('No backup folder access');

    getByRole(t.element, 'button', 'Try again').click();
    await settle(t.fixture);
    http.expectOne('/api/backups').flush(ON);
    await settle(t.fixture);
    expect(t.rows()).toHaveLength(2);
  });

  it('shows that automatic backups are on, the last one and when the next is due', async () => {
    const t = await setup();

    const text = textOf(t.section());
    expect(text).toContain('Automatic backups On: one a day');
    expect(text).toContain(`Last backup ${when('2026-10-03T14:25:30.000Z')}`);
    expect(text).toContain(`Next due ${when('2026-10-04T14:25:30.000Z')}`);
  });

  it('lists the backups newest first, with the file name, a readable size and a download link', async () => {
    const t = await setup();

    expect(t.rows()).toEqual([
      `${when('2026-10-03T14:25:30.000Z')} wallet-20261003-142530.db · 1.5 KB Download`,
      `${when('2026-10-02T14:25:30.000Z')} wallet-20261002-142530.db · 12.3 MB Download`,
    ]);

    const links = queryAllByRole(t.element, 'link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/api/backups/wallet-20261003-142530.db',
      '/api/backups/wallet-20261002-142530.db',
    ]);
    expect(links.every((link) => link.hasAttribute('download'))).toBe(true);
    // Each link says which backup it is, since "Download" alone says nothing.
    expect(links[0].getAttribute('aria-label')).toBe(
      `Download the backup of ${when('2026-10-03T14:25:30.000Z')}`,
    );
  });

  it('says there is none yet, and that the first comes from the button or the schedule', async () => {
    const t = await setup(backupsDto({ nextDueAt: '2026-10-03T14:25:30.000Z' }));

    expect(textOf(t.section())).toContain('Last backup None yet');
    expect(textOf(t.section())).toContain('No backups yet');
    expect(queryByRole(t.element, 'list', 'Backups, newest first')).toBeNull();
  });

  it('explains up front that backups are off, with no backup folder, and turns the button off', async () => {
    const t = await setup(backupsDto({ automatic: false }));

    expect(textOf(t.section())).toContain('Automatic backups Off: this server has no backup folder.');
    expect(textOf(t.section())).toContain('Set BACKUP_DIR');
    expect(t.button().disabled).toBe(true);
    expect(textOf(t.section())).not.toContain('Next due');
  });

  it('reminds in one quiet line that a backup holds everything and how to restore it', async () => {
    const t = await setup();

    const text = textOf(t.section());
    expect(text).toContain('A backup holds all your data, so keep it private.');
    expect(text).toContain('stop the app, copy the backup over the database file');
    expect(text).toContain('There is no restore button.');
    expect(queryByRole(t.element, 'button', /restore/i)).toBeNull();
  });

  describe('Back up now', () => {
    it('makes a backup (POST with no body), shows it busy, then loads the list again', async () => {
      const t = await setup();

      await t.press();
      const request = http.expectOne('/api/backups');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toBeNull();
      expect(t.button().disabled).toBe(true);
      expect(t.button().getAttribute('aria-busy')).toBe('true');

      const made = backupDto({ name: 'wallet-20261003-150000.db', createdAt: '2026-10-03T15:00:00.000Z' });
      request.flush(made);
      await settle(t.fixture);
      http.expectOne('/api/backups').flush({ ...ON, backups: [made, ...ON.backups] });
      await settle(t.fixture);

      expect(t.toasts()).toEqual(['Backup made: wallet-20261003-150000.db.']);
      expect(t.rows()).toHaveLength(3);
      expect(t.rows()[0]).toContain('wallet-20261003-150000.db');
      expect(t.button().disabled).toBe(false);
      expect(queryByRole(t.element, 'alert')).toBeNull();
    });

    it('cannot be sent twice while it is under way', async () => {
      const t = await setup();

      await t.press();
      const request = http.expectOne('/api/backups');
      t.button().click();
      await settle(t.fixture);
      http.expectNone('/api/backups');

      request.flush(backupDto());
      await settle(t.fixture);
      http.expectOne('/api/backups').flush(ON);
      await settle(t.fixture);
    });

    it('shows what the API said when it fails, and keeps the button for another try', async () => {
      const t = await setup();

      await t.press();
      flushError(http.expectOne('/api/backups'), 500, 'internal_error', 'The disk is full');
      await settle(t.fixture);

      const alert = getByRole(t.element, 'alert');
      expect(textOf(alert)).toContain('The backup was not made.');
      expect(textOf(alert)).toContain('The disk is full');
      expect(t.button().disabled).toBe(false);
      expect(t.toasts()).toEqual([]);

      // The next try clears the old message.
      await t.press();
      expect(queryByRole(t.element, 'alert')).toBeNull();
      http.expectOne('/api/backups').flush(backupDto());
      await settle(t.fixture);
      http.expectOne('/api/backups').flush(ON);
      await settle(t.fixture);
    });

    it('explains a 409 backups_unavailable instead of showing a generic failure', async () => {
      const t = await setup();

      await t.press();
      flushError(
        http.expectOne('/api/backups'),
        409,
        'backups_unavailable',
        'No backup directory is configured',
      );
      await settle(t.fixture);

      const alert = getByRole(t.element, 'alert');
      expect(textOf(alert)).toContain('Backups are not available on this server.');
      expect(textOf(alert)).toContain('This server has no backup folder, so it cannot make backups.');
      expect(textOf(alert)).toContain('Set BACKUP_DIR');
      expect(textOf(alert)).not.toContain('The backup was not made.');
    });

    // A browser takes focus off a button that becomes disabled and jsdom does not (and ignores
    // `blur()` on a disabled button), so the tests move focus elsewhere themselves while the request
    // is out: without it they would pass with no focus code at all.
    function loseFocus(): void {
      const elsewhere = document.createElement('input');
      document.body.append(elsewhere);
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    }

    it('puts focus back on the button when it is done (a disabled button loses it)', async () => {
      const t = await setup();
      t.button().focus();

      await t.press();
      loseFocus();
      flushError(http.expectOne('/api/backups'), 500, 'internal_error', 'Nope');
      await settle(t.fixture);

      expect(document.activeElement).toBe(t.button());
    });

    it('puts focus back on the button after a backup was made, too', async () => {
      const t = await setup();
      t.button().focus();

      await t.press();
      loseFocus();
      http.expectOne('/api/backups').flush(backupDto());
      await settle(t.fixture);
      http.expectOne('/api/backups').flush(ON);
      await settle(t.fixture);

      expect(document.activeElement).toBe(t.button());
    });
  });

  it('has nothing a screen reader cannot use', async () => {
    const t = await setup();

    expect(a11yProblems(t.element)).toEqual([]);
  });
});
