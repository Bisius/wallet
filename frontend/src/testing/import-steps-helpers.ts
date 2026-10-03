import type { HttpTestingController } from '@angular/common/http/testing';
import type { Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { ImportParseResponse, ImportProfileDto } from '@wallet/shared';
import type { ImportWizardStore } from '../app/features/import/import-wizard.store';
import { textOf } from './dom';
import { parseResponse } from './fixtures';
import { settle } from './harness';
import { chooseFile, csvFile, setupWizard } from './import-harness';

/** The file the specs of the steps use: three columns, a header and two data rows (72 bytes). */
export const SAMPLE_CSV =
  'Date;Amount;Description\n2026-10-01;-3.50;Coffee\n2026-10-02;-12.30;Lunch\n';

/**
 * Chooses `file` in a file input the way a browser does. While a file is chosen the input holds it
 * (`files`, and a `value` with the fake path); the browser fires `change` only when that changes, so
 * a page that wants the same file chosen again must empty the input, and setting `value` to "" does
 * that here too.
 */
export function pickFile(input: HTMLInputElement, file: File): void {
  let chosen: File | null = file;
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => (chosen === null ? [] : [chosen]),
  });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => (chosen === null ? '' : `C:\\fakepath\\${chosen.name}`),
    set: (value: string) => {
      if (value === '') chosen = null;
    },
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface MountOptions {
  /** The saved profiles the server lists, or `'error'` for a list that cannot be loaded. */
  profiles?: ImportProfileDto[] | 'error';
  /**
   * The file the user has chosen already and what `parse` said about it. Omitted: the default
   * three-column file (`SAMPLE_CSV`, `parseResponse()`). `null`: no file chosen yet.
   */
  file?: { name?: string; text?: string; parse?: ImportParseResponse } | null;
}

export interface Mounted<T> {
  fixture: ComponentFixture<T>;
  element: HTMLElement;
  wizard: ImportWizardStore;
}

/**
 * Creates the stores of the import page (answering what creating them asks), reads a file into the
 * wizard, then renders `component` as the page would. The stores must be provided by the spec
 * (`IMPORT_STORES`). The budgets that the review store asks for once a file is read are answered with
 * none, for the steps that use that store.
 */
export async function mountStep<T>(
  http: HttpTestingController,
  component: Type<T>,
  options: MountOptions = {},
): Promise<Mounted<T>> {
  const wizard = await setupWizard(http, { profiles: options.profiles });
  if (options.file !== null) {
    const file = options.file ?? {};
    await chooseFile(
      http,
      wizard,
      csvFile(file.text ?? SAMPLE_CSV, file.name ?? 'bank.csv'),
      file.parse ?? parseResponse(),
    );
  }

  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  await settle(fixture);
  await answerBudgetsIfAsked(http, fixture);
  return { fixture, element: fixture.nativeElement as HTMLElement, wizard };
}

/**
 * Answers with no budgets any request for them that is open, and does nothing when there is none.
 * The review store asks for them once a file is read, and again each time the answer of `parse`
 * changes (a new delimiter, a profile with another one).
 */
export async function answerBudgetsIfAsked(
  http: HttpTestingController,
  fixture: ComponentFixture<unknown>,
): Promise<void> {
  for (const request of http.match('/api/budgets')) request.flush([]);
  await settle(fixture);
}

/** What a control says about itself besides its label: the hint and error its `aria-describedby` names. */
export function describedText(control: HTMLElement): string {
  const root = control.getRootNode() as Document | ShadowRoot;
  return (control.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => root.getElementById(id))
    .filter((target): target is HTMLElement => target !== null)
    .map((target) => textOf(target))
    .join(' ');
}

/** The texts of the options of a `<select>`, in order. */
export function optionTexts(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((option) => textOf(option));
}

/** The text of the option a `<select>` shows as chosen. */
export function selectedText(select: HTMLElement): string {
  const chosen = (select as HTMLSelectElement).selectedOptions[0];
  return chosen ? textOf(chosen) : '';
}
