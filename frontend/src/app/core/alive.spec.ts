import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { aliveFlag } from './alive';

@Component({ selector: 'app-alive-probe', template: '' })
class AliveProbe {
  readonly alive = aliveFlag();
}

describe('aliveFlag', () => {
  it('is true while the component lives and false once it is destroyed', () => {
    const fixture = TestBed.createComponent(AliveProbe);
    const { alive } = fixture.componentInstance;

    expect(alive()).toBe(true);
    fixture.destroy();
    expect(alive()).toBe(false);
  });
});
