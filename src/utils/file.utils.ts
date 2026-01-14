import fs from "fs/promises";
import path from "path";
import { PATHS } from "../config/constants";
import { log } from "../services/logger.service";

export class FileUtils {
  static async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      const stats = await fs.stat(dirPath);

      if (!stats.isDirectory()) {
        await fs.mkdir(dirPath, { recursive: true });
      }
    } catch (err) {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  static async createTempDirectory(): Promise<void> {
    const tempPath = path.join(process.cwd(), PATHS.TEMP);
    await FileUtils.ensureDirectoryExists(tempPath);
  }

  static async safeUnlink(filePath: string): Promise<boolean> {
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      log.warn(`Failed to remove file: ${filePath}`, err);
      return false;
    }
  }

  static async removeDirectory(dirPath: string): Promise<boolean> {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return true;
    } catch (err) {
      log.error(`Failed to remove directory: ${dirPath}`, err);
      return false;
    }
  }

  static async listFiles(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch (err) {
      log.error(`Failed to list files in: ${dirPath}`, err);
      return [];
    }
  }
}
