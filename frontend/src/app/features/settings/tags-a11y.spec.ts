import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole } from '../../../testing/dom';
import { tagDto } from '../../../testing/fixtures';
import { primeStores, settle } from '../../../testing/harness';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { TagsSection } from './tags-section';

@Component({
  selector: 'app-tags-a11y-host',
  imports: [TagsSection, ConfirmDialog],
  template: '<app-tags-section /><app-confirm-dialog />',
})
class Host {}

describe('TagsSection: markup a screen reader can use', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup() {
    await primeStores(http);
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await settle(fixture);
    http
      .expectOne('/api/tags')
      .flush([
        tagDto({ id: 1, name: 'Groceries', color: '#2563eb', usageCount: 4 }),
        tagDto({ id: 2, name: 'Travel', usageCount: 0 }),
      ]);
    await settle(fixture);
    return fixture.nativeElement as HTMLElement;
  }

  it('has nothing wrong with the list', async () => {
    expect(a11yProblems(await setup())).toEqual([]);
  });

  it('has nothing wrong with the edit dialog', async () => {
    const element = await setup();
    getByRole(element, 'button', 'Edit tag Groceries').click();
    await settle();

    expect(a11yProblems(element)).toEqual([]);
  });
});
