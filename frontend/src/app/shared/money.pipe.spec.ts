import { MoneyPipe } from './money.pipe';
import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

describe('MoneyPipe', () => {
  function create(locale: string) {
    TestBed.configureTestingModule({
      providers: [MoneyPipe, { provide: LOCALE_ID, useValue: locale }],
    });
    return TestBed.inject(MoneyPipe);
  }

  it('formats cents as currency', () => {
    expect(create('en-US').transform(123456, 'EUR')).toBe('€1,234.56');
  });

  it('renders nothing for missing values', () => {
    expect(create('en-US').transform(null)).toBe('');
  });
});
