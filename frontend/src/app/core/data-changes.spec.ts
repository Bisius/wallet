import { httpResource, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { textOf } from '../../testing/dom';
import { render, settle } from '../../testing/harness';
import { DataChanges, reloadOnDataChange } from './data-changes';

/** A page with a figure that a change made elsewhere moves: it shows what the server says. */
@Component({
  selector: 'app-figure-page',
  template: `<p>{{ text() }}</p>`,
})
class FigurePage {
  private readonly figure = reloadOnDataChange(
    httpResource<{ spent: number }>(() => '/api/figure'),
  );
  protected readonly text = () =>
    this.figure.hasValue() ? `spent ${this.figure.value().spent}` : '…';
}

@Component({
  selector: 'app-figure-host',
  imports: [FigurePage],
  template: `
    @if (shown()) {
      <app-figure-page />
    }
  `,
})
class FigureHost {
  readonly shown = signal(true);
}

describe('DataChanges', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open() {
    const fixture = await render(FigureHost);
    http.expectOne('/api/figure').flush({ spent: 100 });
    await settle(fixture);
    return { fixture, text: () => textOf(fixture.nativeElement as HTMLElement) };
  }

  it('does not load anything again by itself', async () => {
    const { text } = await open();

    expect(text()).toBe('spent 100');
    http.expectNone('/api/figure');
  });

  it('loads a resource again when something changed, and keeps the figure on screen meanwhile', async () => {
    const { fixture, text } = await open();

    TestBed.inject(DataChanges).notify();
    await settle(fixture);

    // The old figure stays (no flash of "loading") until the new one is in.
    expect(text()).toBe('spent 100');
    http.expectOne('/api/figure').flush({ spent: 112 });
    await settle(fixture);
    expect(text()).toBe('spent 112');
  });

  it('loads again at every change', async () => {
    const { fixture, text } = await open();
    const changes = TestBed.inject(DataChanges);

    changes.notify();
    await settle(fixture);
    http.expectOne('/api/figure').flush({ spent: 112 });
    await settle(fixture);
    changes.notify();
    await settle(fixture);
    http.expectOne('/api/figure').flush({ spent: 120 });
    await settle(fixture);

    expect(text()).toBe('spent 120');
    expect(changes.version()).toBe(2);
  });

  it('waits for a load that is already out, then asks again, so a stale answer is not kept', async () => {
    const fixture = await render(FigureHost);
    const first = http.expectOne('/api/figure');

    // The change is made while the first load is on its way: its answer may be from before it.
    TestBed.inject(DataChanges).notify();
    await settle(fixture);
    first.flush({ spent: 100 });
    await settle(fixture);

    http.expectOne('/api/figure').flush({ spent: 112 });
    await settle(fixture);
    expect(textOf(fixture.nativeElement)).toBe('spent 112');
  });

  it('stops following once the page is gone', async () => {
    const { fixture } = await open();

    fixture.componentInstance.shown.set(false);
    await settle(fixture);
    TestBed.inject(DataChanges).notify();
    await settle(fixture);

    http.expectNone('/api/figure');
  });

  it('does nothing for a resource that asks for nothing yet', async () => {
    @Component({ selector: 'app-idle-page', template: '' })
    class IdlePage {
      readonly idle = reloadOnDataChange(httpResource<string>(() => undefined));
    }
    const fixture = await render(IdlePage);

    TestBed.inject(DataChanges).notify();
    await settle(fixture);

    http.expectNone(() => true);
  });
});
