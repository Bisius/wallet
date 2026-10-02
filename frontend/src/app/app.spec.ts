import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('renders the main navigation and checks API health', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/health')
      .flush({ status: 'ok', time: '2026-01-01T00:00:00.000Z' });
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    const links = Array.from(element.querySelectorAll('nav a')).map((a) => a.textContent?.trim());
    expect(links).toEqual([
      'Dashboard',
      'Budgets',
      'Spendings',
      'Subscriptions',
      'Income',
      'Savings',
      'Settings',
    ]);
    expect(element.querySelector('[title="API connected"]')).not.toBeNull();
  });
});
