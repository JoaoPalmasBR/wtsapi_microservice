import Sentry from "@sentry/node";
import pool from "../libs/pq";
import { log } from "../services/logger.service";

new (class SessionsCacheManager {
  constructor() {
    this.init();
  }

  async init() {
    try {
      const query = `CREATE TABLE IF NOT EXISTS sessions_cache (
        token VARCHAR(255) PRIMARY KEY,
        data JSONB,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`;

      await pool.query(query);

      log.info("sessions_cache table initialized successfully");
    } catch (er) {
      log.error("Error initializing sessions_cache table:", er);
      Sentry.captureException(er);
    }
  }
})();
