import { Component, computed, input } from '@angular/core';

/** 24x24 stroke icons (Lucide shapes). Add a path here to add an icon. */
const PATHS = {
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  'arrow-up': 'm5 12 7-7 7 7M12 19V5',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  'arrows-left-right': 'M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM4.9 4.9l14.2 14.2',
  tag: 'M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4ZM7.5 7.5h.01',
  check: 'M20 6 9 17l-5-5',
  'check-circle': 'M21.8 10A10 10 0 1 1 17 3.3M9 11l3 3L22 4',
  x: 'M18 6 6 18M6 6l12 12',
  plus: 'M5 12h14M12 5v14',
  alert: 'm21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3M12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01',
  pencil:
    'M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5ZM15 5l4 4',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  trash:
    'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6',
} as const;

export type IconName = keyof typeof PATHS;

/** A decorative icon. It is hidden from assistive technology, so always pair it with text or a label. */
@Component({
  selector: 'app-icon',
  template: `
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-4 shrink-0"
    >
      <path [attr.d]="path()" />
    </svg>
  `,
  host: { class: 'inline-flex' },
})
export class Icon {
  readonly name = input.required<IconName>();
  protected readonly path = computed(() => PATHS[this.name()]);
}
