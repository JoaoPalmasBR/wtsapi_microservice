import { Pool } from "pg";
import Sentry from "@sentry/node";

import { camelToSnakeCase } from "../utils/strings";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const publishEvent = async (queue: string, queue_fun: string, payload: any) => {
  const queues_itens = queue_fun.split(".");
  console.log(
    `OBAN_PUBLISHER: Publishing event to queue: ${queue}, function: ${camelToSnakeCase(queues_itens[queues_itens.length - 1])}`,
  );

  try {
    const query = `
      INSERT INTO oban_jobs (queue, worker, args, state, inserted_at, scheduled_at)
      VALUES ($1, $2, $3::jsonb, 'available', now(), now())
    `;

    await pool.query(query, [queue, queue_fun, JSON.stringify(payload)]);
  } catch (err) {
    console.error("Error publishing event to oban_jobs:", err);
    Sentry.captureException(err);
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
}

export default pool;
