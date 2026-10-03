import { a11yProblems } from './a11y';

/** Builds markup in the page, runs the checks, and cleans up. */
function check(html: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    return a11yProblems(host);
  } finally {
    host.remove();
  }
}

describe('a11yProblems', () => {
  it('finds nothing wrong with a labelled form', () => {
    expect(
      check(`
        <label for="name">Name</label><input id="name" aria-describedby="hint" />
        <p id="hint">Up to 30 characters</p>
        <button type="button">Save</button>
        <button type="button" aria-label="Remove tag Travel"><svg aria-hidden="true"></svg></button>
      `),
    ).toEqual([]);
  });

  it('finds a control without a name, and a button without one', () => {
    const problems = check('<input id="x" /><button type="button"></button>');
    expect(problems).toContain('<input#x> has no name');
    expect(problems).toContain('<button> has no name');
  });

  it('finds an aria attribute that points at nothing, and a label for nothing', () => {
    const problems = check(`
      <label for="ghost">Ghost</label>
      <input aria-label="A" aria-describedby="missing" aria-controls="" />
    `);
    expect(problems).toContain('<input> aria-describedby points at "missing", which is not there');
    expect(problems).toContain('<input> has an empty aria-controls');
    expect(problems).toContain('A label points at "ghost", which is not there');
  });

  it('finds a duplicate id', () => {
    expect(check('<p id="a">1</p><p id="a">2</p>')).toContain('The id "a" is used 2 times');
  });

  it('finds an incomplete combobox and an option outside a listbox', () => {
    const problems = check(`
      <input role="combobox" aria-label="Tags" />
      <ul id="list"><li role="option">One</li></ul>
    `);
    expect(problems).toContain('<input role=combobox> has no aria-expanded');
    expect(problems).toContain('<input role=combobox> does not control a listbox');
    expect(problems).toContain('<li role=option> is not in a listbox');
  });

  it('accepts a complete combobox', () => {
    expect(
      check(`
        <input role="combobox" aria-label="Tags" aria-expanded="false" aria-controls="list" />
        <ul id="list" role="listbox" aria-label="Suggestions"><li role="option" id="o1">One</li></ul>
      `),
    ).toEqual([]);
  });

  it('leaves a dialog that is not open, and what is in it, alone', () => {
    expect(check('<dialog aria-labelledby="gone"><input /><button></button></dialog>')).toEqual([]);
    expect(check('<dialog open aria-labelledby="gone"><input /></dialog>')).not.toEqual([]);
  });

  it('finds something focusable inside aria-hidden, an unnamed svg and an empty heading', () => {
    const problems = check(`
      <div aria-hidden="true"><button type="button">Hidden</button></div>
      <svg></svg>
      <h2> </h2>
      <p tabindex="3">x</p>
    `);
    expect(problems).toContain('<div> is aria-hidden but holds <button>');
    expect(problems).toContain('An svg is neither hidden nor named');
    expect(problems).toContain('<h2> is empty');
    expect(problems).toContain('<p> has a positive tabindex');
  });
});
