import type { ActivatedRouteSnapshot } from '@angular/router';
import { activeRouteData } from './route-data';

const route = (data: object, child: ActivatedRouteSnapshot | null = null) =>
  ({ data, firstChild: child }) as unknown as ActivatedRouteSnapshot;

describe('activeRouteData', () => {
  it('collects the data of the active route and its parents, the deepest winning', () => {
    const snapshot = route(
      { monthScoped: false, focusLayout: true },
      route({}, route({ monthScoped: true })),
    );

    expect(activeRouteData(snapshot)).toEqual({ monthScoped: true, focusLayout: true });
  });

  it('is empty for a route without data', () => {
    expect(activeRouteData(route({}))).toEqual({});
  });
});
