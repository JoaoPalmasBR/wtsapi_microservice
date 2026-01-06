import "./libs/sentry";

import dotenv from "dotenv";

dotenv.config();

import "./modules/websocket";

import "./modules/emails";
import "./modules/whatsapp"
// import "./modules/whatsapp-session";

import "./modules/notifications";

async function main() {
  console.info("WTSAPI: Microservice started successfully");

  const createTempDir = async () => {
    const fs = await import("fs/promises");
    const path = await import("path");

    const pathTemp = path.join(process.cwd(), "temp");

    try {
      const stats = await fs.stat(pathTemp);

      if (!stats.isDirectory()) {
        await fs.mkdir(pathTemp, { recursive: true });
      }
    } catch (err) {
      await fs.mkdir(pathTemp, { recursive: true });
    }
  };

  await createTempDir();
}

main();
