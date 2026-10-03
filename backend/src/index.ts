import { createApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';

const config = loadConfig();
const db = createDb(config.databasePath);
runMigrations(db);

const app = createApp({ db, config });
// Express 5 passes a listen failure (such as EADDRINUSE) to this callback instead of throwing, so
// it must be handled here: otherwise the process would claim to listen, then exit with code 0.
const server = app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    console.error(`Cannot listen on ${config.host}:${config.port}: ${error.message}`);
    process.exit(1);
  }
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
