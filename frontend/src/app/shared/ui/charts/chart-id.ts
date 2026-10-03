let counter = 0;

/** A document-unique id for the parts of a chart that point at each other (`aria-controls`, ...). */
export function chartId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
