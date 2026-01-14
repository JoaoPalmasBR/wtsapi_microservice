import { Pool } from "pg";
import Sentry from "@sentry/node";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default pool;

export const publishEvent = async (queue: string, queue_fun: string, payload: any) => {
  console.log(`Publishing event to queue: ${queue}, function: ....${queue_fun.slice(-50)}`);

  try {
    await pool.query(
      `
    INSERT INTO oban_jobs
      (queue, worker, args, state, inserted_at, scheduled_at)
    VALUES
      ($1, $2, $3::jsonb, 'available', now(), now())
    `,
      [queue, queue_fun, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error("Error publishing event to oban_jobs:", err);
    Sentry.captureException(err);
  }
};
