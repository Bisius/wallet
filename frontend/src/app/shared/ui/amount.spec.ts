import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { primeStores, render, settle } from '../../../testing/harness';
import { Amount } from './amount';

@Component({
  selector: 'app-amount-host',
  imports: [Amount],
  template: `
    <app-amount id="spent" [cents]="1250" />
    <app-amount id="over" [cents]="-4000" />
    <app-amount id="in" [cents]="30000" [signed]="true" />
    <app-amount id="zero" [cents]="0" [signed]="true" />
    <app-amount id="refund" [cents]="-500" [signed]="true" />
    <app-amount id="below" [cents]="-12000" plain />
    <app-amount id="plain-in" [cents]="3000" [signed]="true" plain />
    <app-amount id="spending" [cents]="350" outflow />
    <app-amount id="money-back" [cents]="-4500" outflow />
    <app-amount id="money-back-plain" [cents]="-4500" outflow plain />
  `,
})
class AmountHost {}

describe('Amount', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup() {
    const fixture = await render(AmountHost);
    await primeStores(http);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const span = (id: string) => element.querySelector(`#${id} span`) as HTMLElement;
    return { span };
  }

  it('shows a negative amount with its minus sign, and in red: the sign carries the meaning, not the color', async () => {
    const { span } = await setup();

    expect(span('over').textContent).toBe('-€40.00');
    expect(span('over').className).toContain('text-negative');
  });

  it('can keep the text color for a figure that is not bad news, the minus sign still showing', async () => {
    const { span } = await setup();

    expect(span('below').textContent).toBe('-€120.00');
    expect(span('below').className).not.toContain('text-negative');
    expect(span('plain-in').textContent).toBe('+€30.00');
    expect(span('plain-in').className).not.toContain('text-positive');
  });

  it('leaves an ordinary amount plain', async () => {
    const { span } = await setup();

    expect(span('spent').textContent).toBe('€12.50');
    expect(span('spent').className).not.toContain('text-negative');
    expect(span('spent').className).not.toContain('text-positive');
  });

  it('puts a plus sign before money that came in', async () => {
    const { span } = await setup();

    expect(span('in').textContent).toBe('+€300.00');
    expect(span('in').className).toContain('text-positive');
  });

  it('has no sign or color for zero, and keeps the minus of a negative signed amount', async () => {
    const { span } = await setup();

    expect(span('zero').textContent).toBe('€0.00');
    expect(span('zero').className).not.toContain('text-positive');
    expect(span('refund').textContent).toBe('-€5.00');
    expect(span('refund').className).toContain('text-negative');
  });

  it('shows money that went out in plain, and the refund of it in green with its minus sign', async () => {
    const { span } = await setup();

    expect(span('spending').textContent).toBe('€3.50');
    expect(span('spending').className).not.toContain('text-positive');
    expect(span('spending').className).not.toContain('text-negative');
    expect(span('money-back').textContent).toBe('-€45.00');
    expect(span('money-back').className).toContain('text-positive');
    expect(span('money-back').className).not.toContain('text-negative');
    expect(span('money-back-plain').className).not.toContain('text-positive');
  });
});
