import { Pool } from "pg";
import Sentry from "@sentry/node";

import { camelToSnakeCase } from "../utils/strings";
import { log } from "../services/logger.service";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err, client) => {
  log.error("Erro inesperado no pool de conexões:", err);
  Sentry.captureException(err);
});

pool.on("connect", (client) => {
  log.info("Nova conexão estabelecida no pool");
});

pool.on("remove", (client) => {
  log.info("Conexão removida do pool");
});

export const publishEvent = async (queue: string, queue_fun: string, payload: any) => {
  const queues_itens = queue_fun.split(".");
  log.info(`Publishing event to queue: ${queue}, function: ${camelToSnakeCase(queues_itens[queues_itens.length - 1])}`);

  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO oban_jobs (queue, worker, args, state, inserted_at, scheduled_at)
      VALUES ($1, $2, $3::jsonb, 'available', now(), now())
    `;

    await client.query(query, [queue, queue_fun, JSON.stringify(payload)]);
  } catch (err) {
    log.error("Error publishing event to oban_jobs:", err);
    Sentry.captureException(err);
    throw err;
  } finally {
    client.release(); // IMPORTANTE: sempre libera a conexão de volta ao pool
  }
};

export const saveSessionCache = async (token: string, sessionData: any) => {
  const query = `
    INSERT INTO sessions_cache (token, data, updated_at)
    VALUES ($1, $2::jsonb, now())
    ON CONFLICT (token)
    DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
  await pool.query(query, [token, JSON.stringify(sessionData)]);
};

export const getSessionCache = async (token: string): Promise<any | null> => {
  const query = `
    SELECT data
    FROM sessions_cache
    WHERE token = $1
  `;
  const result = await pool.query(query, [token]);

  if (result.rows.length > 0) {
    return result.rows[0].data;
  }

  return null;
};

export const deleteSessionCache = async (token: string): Promise<void> => {
  const query = `
    DELETE FROM sessions_cache
    WHERE token = $1
  `;
  await pool.query(query, [token]);
};

export default pool;
