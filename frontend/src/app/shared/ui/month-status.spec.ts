import { Component } from '@angular/core';
import { textOf } from '../../../testing/dom';
import { render } from '../../../testing/harness';
import { MONTH_STATUS_LABELS, MonthStatusBadge } from './month-status';

@Component({
  selector: 'app-status-host',
  imports: [MonthStatusBadge],
  template: `
    <app-month-status status="closed" />
    <app-month-status status="current" />
    <app-month-status status="future" />
  `,
})
class StatusHost {}

describe('MonthStatusBadge', () => {
  it('names the status in words: closed, current or a projection', async () => {
    const fixture = await render(StatusHost);
    const badges = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('app-month-status'),
    ).map((badge) => textOf(badge));

    expect(badges).toEqual(['Closed month', 'Current month', 'Projection']);
    expect(MONTH_STATUS_LABELS).toEqual({
      closed: 'Closed month',
      current: 'Current month',
      future: 'Projection',
    });
  });
});
