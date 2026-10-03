/** Which text encoding the bytes of a file were read as. */
export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedCsv {
  text: string;
  encoding: CsvEncoding;
}

/**
 * Turns the bytes of a file into text, because the importer only ever sees text. A file is read as
 * UTF-8; when its bytes are not valid UTF-8 it is read as windows-1252, which is what the exports of
 * most banks use. (A file that starts with a UTF-16 byte order mark, as Excel's "Unicode Text" does,
 * is read as UTF-16.) A byte order mark is dropped by the decoder, and the server drops one too.
 *
 * windows-1252 maps every byte to a character, so the fallback never fails: a file in yet another
 * encoding shows odd characters instead of an error.
 */
export function decodeCsvBytes(source: ArrayBuffer | ArrayBufferView): DecodedCsv {
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/** How a file's encoding is told to the user, or null for the usual one (UTF-8: nothing to say). */
export function encodingNote(encoding: CsvEncoding): string | null {
  switch (encoding) {
    case 'utf-8':
      return null;
    case 'windows-1252':
      return "It isn't valid UTF-8, so it was read as windows-1252, the usual encoding of bank files. If accents look wrong in the preview, save the file as UTF-8 and choose it again.";
    default:
      return 'It starts with a UTF-16 byte order mark, so it was read as UTF-16.';
  }
}
