import { decodeCsvBytes, encodingNote } from './decode-csv';

const bytes = (...values: number[]) => new Uint8Array(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe('decodeCsvBytes', () => {
  it('reads valid UTF-8 as UTF-8', () => {
    const decoded = decodeCsvBytes(utf8('Café;12,50\n'));

    expect(decoded).toEqual({ text: 'Café;12,50\n', encoding: 'utf-8' });
  });

  it('accepts an ArrayBuffer as well as a view of one', () => {
    const buffer = utf8('Zürich').buffer as ArrayBuffer;

    expect(decodeCsvBytes(buffer).text).toBe('Zürich');
    expect(decodeCsvBytes(new Uint8Array(buffer)).text).toBe('Zürich');
  });

  it('drops a UTF-8 byte order mark', () => {
    const decoded = decodeCsvBytes(bytes(0xef, 0xbb, 0xbf, ...utf8('Date;Amount')));

    expect(decoded).toEqual({ text: 'Date;Amount', encoding: 'utf-8' });
  });

  it('falls back to windows-1252 when the bytes are not valid UTF-8', () => {
    // "Café €5" in windows-1252: é is 0xE9 and the euro sign 0x80, neither valid UTF-8 alone.
    const decoded = decodeCsvBytes(bytes(0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35));

    expect(decoded).toEqual({ text: 'Café €5', encoding: 'windows-1252' });
  });

  it('reads a lone high byte in the middle of a text as windows-1252, never failing', () => {
    const decoded = decodeCsvBytes(bytes(0x61, 0xff, 0x62));

    expect(decoded).toEqual({ text: 'aÿb', encoding: 'windows-1252' });
  });

  it('keeps UTF-8 text that merely looks unusual (emoji, CJK)', () => {
    expect(decodeCsvBytes(utf8('Sushi 🍣 寿司')).encoding).toBe('utf-8');
  });

  it('reads an empty file as empty UTF-8', () => {
    expect(decodeCsvBytes(new Uint8Array())).toEqual({ text: '', encoding: 'utf-8' });
  });

  it('reads UTF-16 when the file starts with its byte order mark', () => {
    const little = bytes(0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00);
    const big = bytes(0xfe, 0xff, 0x00, 0x41, 0x00, 0xe9);

    expect(decodeCsvBytes(little)).toEqual({ text: 'Aé', encoding: 'utf-16le' });
    expect(decodeCsvBytes(big)).toEqual({ text: 'Aé', encoding: 'utf-16be' });
  });
});

describe('encodingNote', () => {
  it('says nothing about the usual encoding', () => {
    expect(encodingNote('utf-8')).toBeNull();
  });

  it('tells the user when the fallback was used, and what to do about odd accents', () => {
    expect(encodingNote('windows-1252')).toContain('windows-1252');
    expect(encodingNote('windows-1252')).toContain('save the file as UTF-8');
  });

  it('tells the user about UTF-16', () => {
    expect(encodingNote('utf-16le')).toContain('UTF-16');
  });
});
