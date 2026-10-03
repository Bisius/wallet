import {
  type ImportMapping,
  type ImportProfileDto,
  type ImportProfileInput,
  importMappingSchema,
} from '@wallet/shared';
import { desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import { importProfiles } from '../../db/schema';
import type { Deps } from '../../lib/deps';
import { apiError, notFound } from '../../lib/errors';
import { isInvisibleName, isSameName, nameCollator } from '../../lib/names';
import { timestampOf } from '../../lib/today';
import { normalizeText } from './import.file';

type ProfileRow = typeof importProfiles.$inferSelect;

/** What `header_signature` holds: the normalized header cells, or nothing. */
const headerSignatureSchema = z.array(z.string()).nullable();

/**
 * The mapping and the signature of a stored profile, validated like a request's (a database that
 * was edited by hand, or restored from another version, can hold anything). `null` when either does
 * not fit the contract.
 */
function readStored(row: ProfileRow): { mapping: ImportMapping; header: string[] | null } | null {
  const mapping = importMappingSchema.safeParse(row.mapping);
  const header = headerSignatureSchema.safeParse(row.headerSignature);
  return mapping.success && header.success ? { mapping: mapping.data, header: header.data } : null;
}

/** A profile as a DTO. A stored profile that does not fit the contract is a server error (500). */
function toDto(row: ProfileRow): ImportProfileDto {
  const stored = readStored(row);
  if (!stored) {
    throw new Error(`Import profile ${row.id} holds a mapping or header that is not valid`);
  }
  return { id: row.id, name: row.name, mapping: stored.mapping, header: stored.header };
}

/**
 * The signature a profile is saved with: the header cells normalized (`normalizeText`), only for a
 * mapping that says the file has a header, and only when `header` is given. Otherwise null.
 */
function signatureOf(input: ImportProfileInput): string[] | null {
  if (!input.mapping.hasHeader || input.header == null) return null;
  return input.header.map(normalizeText);
}

/**
 * A name made only of invisible characters is a 400 at `name`, like a tag's. It is a shape error,
 * so it comes before the 404 and the 409.
 */
function assertNameVisible(name: string): void {
  if (isInvisibleName(name)) {
    throw apiError('validation_error', 'Invalid request', [
      { path: 'name', message: 'Name is required' },
    ]);
  }
}

/**
 * `import_profile_name_taken`: no OTHER profile may have this name under the tag-name comparison
 * (case is ignored, accents are not). SQLite's unique index is case-sensitive, so it is only a
 * backstop. A profile never clashes with itself (`exceptId`).
 */
function assertNameFree(db: DbOrTx, name: string, exceptId?: number): void {
  const taken = db
    .select({ id: importProfiles.id, name: importProfiles.name })
    .from(importProfiles)
    .all()
    .find((profile) => profile.id !== exceptId && isSameName(profile.name, name));
  if (taken) {
    throw apiError(
      'import_profile_name_taken',
      `Another import profile is already called "${taken.name}"`,
    );
  }
}

/** GET /api/import/profiles: ascending by name (case ignored), then id. */
export function listProfiles({ db }: Deps): ImportProfileDto[] {
  return db
    .select()
    .from(importProfiles)
    .all()
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id)
    .map(toDto);
}

/** POST /api/import/profiles. Checks, in order: 400 (the shape, a blank name), then 409. */
export function createProfile({ db, clock }: Deps, input: ImportProfileInput): ImportProfileDto {
  assertNameVisible(input.name);
  assertNameFree(db, input.name);
  const now = timestampOf(clock);
  const row = db
    .insert(importProfiles)
    .values({
      name: input.name,
      mapping: input.mapping,
      headerSignature: signatureOf(input),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDto(row);
}

/**
 * PUT /api/import/profiles/:id: REPLACES the profile (the signature included: no `header` clears
 * it). Checks, in order: 400, 404, then 409 (the profile's own name never clashes).
 */
export function replaceProfile(
  { db, clock }: Deps,
  id: number,
  input: ImportProfileInput,
): ImportProfileDto {
  assertNameVisible(input.name);
  const current = db
    .select({ id: importProfiles.id })
    .from(importProfiles)
    .where(eq(importProfiles.id, id))
    .get();
  if (!current) throw notFound('Import profile');
  assertNameFree(db, input.name, id);

  const row = db
    .update(importProfiles)
    .set({
      name: input.name,
      mapping: input.mapping,
      headerSignature: signatureOf(input),
      updatedAt: timestampOf(clock),
    })
    .where(eq(importProfiles.id, id))
    .returning()
    .get();
  return toDto(row);
}

/** DELETE /api/import/profiles/:id. A profile belongs to no spending, so nothing else changes. */
export function deleteProfile({ db }: Deps, id: number): void {
  const removed = db
    .delete(importProfiles)
    .where(eq(importProfiles.id, id))
    .returning({ id: importProfiles.id })
    .all();
  if (removed.length === 0) throw notFound('Import profile');
}

/**
 * `suggestedProfileId` of `parse` (docs/DOMAIN.md, "Profiles"): a profile with a signature whose
 * three mapped columns each equal, normalized, the file's header cell at that position. Several
 * match: the most recently updated, then the highest id. A profile with no signature is never
 * suggested, nor is one the file's header is too short for. A stored profile that does not fit the
 * contract is skipped: it cannot be applied, and one bad row must not stop an import.
 */
export function suggestProfileId(db: DbOrTx, header: readonly string[]): number | null {
  const normalized = header.map(normalizeText);
  const candidates = db
    .select()
    .from(importProfiles)
    .where(isNotNull(importProfiles.headerSignature))
    .orderBy(desc(importProfiles.updatedAt), desc(importProfiles.id))
    .all();

  for (const row of candidates) {
    const stored = readStored(row);
    if (!stored?.header) continue;
    const { mapping, header: signature } = stored;
    const fits = [mapping.dateColumn, mapping.amountColumn, mapping.descriptionColumn].every(
      (column) => {
        const expected = signature[column];
        return expected !== undefined && expected === normalized[column];
      },
    );
    if (fits) return row.id;
  }
  return null;
}
