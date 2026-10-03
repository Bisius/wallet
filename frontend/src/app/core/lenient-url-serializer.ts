import { DefaultUrlSerializer, type UrlTree } from '@angular/router';

/**
 * Reads the address like the router does, except for an address it cannot decode. A `%` that is not
 * the start of an escape (`/spendings?q=50%`, typed by hand or cut off by a chat app) cannot be
 * decoded, and the router's answer to that is to forget the whole address and open `/`: the
 * Dashboard, whichever page the link was for. The path before the `?` is nearly always fine, so this
 * opens that page without the query that could not be read, as it does for a query that is only
 * nonsense (`?minAmount=abc`). An address whose path cannot be read either still goes to `/`.
 */
export class LenientUrlSerializer extends DefaultUrlSerializer {
  override parse(url: string): UrlTree {
    try {
      return super.parse(url);
    } catch (error) {
      const path = url.split(/[?#]/, 1)[0];
      if (path === url) throw error;
      return super.parse(path);
    }
  }
}
