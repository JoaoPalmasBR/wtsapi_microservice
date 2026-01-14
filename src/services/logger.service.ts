import { APP_CONFIG } from "../config/constants";

/**
 * Serviço de logging com prefixo consistente
 */
export class LoggerService {
  private readonly prefix: string;

  constructor(prefix: string = APP_CONFIG.SERVICE_NAME) {
    this.prefix = prefix;
  }

  private formatMessage(message: string): string {
    return `${this.prefix}: ${message}`;
  }

  info(message: string, data?: any): void {
    if (data) {
      console.info(this.formatMessage(message), data);
    } else {
      console.info(this.formatMessage(message));
    }
  }

  error(message: string, error?: Error | string | unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error || "Unknown error");
    console.error(this.formatMessage(message), errorMessage);
  }

  warn(message: string, data?: any): void {
    if (data) {
      console.warn(this.formatMessage(message), data);
    } else {
      console.warn(this.formatMessage(message));
    }
  }

  debug(message: string, data?: any): void {
    if (data) {
      console.debug(this.formatMessage(message), data);
    } else {
      console.debug(this.formatMessage(message));
    }
  }
}

export const log = new LoggerService();
