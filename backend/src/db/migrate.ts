import { loadConfig } from '../config';
import { createDb, runMigrations } from './client';

const config = loadConfig();
const db = createDb(config.databasePath);
runMigrations(db);
db.$client.close();
console.log(`Migrations applied to ${config.databasePath}`);
