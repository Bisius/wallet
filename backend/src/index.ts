import { createApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';

const config = loadConfig();
const db = createDb(config.databasePath);
runMigrations(db);

const app = createApp({ db, config });
const server = app.listen(config.port, config.host, () => {
  console.log(
    `Wallet listening on http://${config.host}:${config.port} (db: ${config.databasePath})`,
  );
  if (config.staticDir) console.log(`Serving frontend from ${config.staticDir}`);
});

function shutdown() {
  server.close(() => {
    db.$client.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
