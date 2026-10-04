import type { ActivatedRouteSnapshot } from '@angular/router';
import { activeRouteData } from './route-data';

const route = (data: object, child: ActivatedRouteSnapshot | null = null) =>
  ({ data, firstChild: child }) as unknown as ActivatedRouteSnapshot;

describe('activeRouteData', () => {
  it('collects the data of the active route and its parents, the deepest winning', () => {
    const snapshot = route(
      { period: 'year', focusLayout: true },
      route({}, route({ period: 'month', hideAddSpending: true })),
    );

    expect(activeRouteData(snapshot)).toEqual({
      period: 'month',
      focusLayout: true,
      hideAddSpending: true,
    });
  });

  it('is empty for a route without data', () => {
    expect(activeRouteData(route({}))).toEqual({});
  });
});
