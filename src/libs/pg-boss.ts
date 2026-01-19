import { PgBoss } from "pg-boss";

export const pgBoss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  migrate: true,
  schema: "pgboss",
  // max: 10,
  // connectionTimeoutMillis: 30000,
  // maintenanceIntervalSeconds: 300,
});
