import type { Db } from '../db/client';

/** Every table of the database, as text, to prove that a refused request changed nothing. */
export function dumpDb(db: Db): string {
  const sqlite = db.$client;
  const tables = sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all() as { name: string }[];
  return JSON.stringify(
    tables.map(({ name }) => [
      name,
      sqlite.prepare(`select * from "${name}" order by rowid`).all(),
    ]),
  );
}
