import pino from "pino";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      singleLine: true,
      ignore: "pid,hostname",
      // translateTime: "SYS:standard",
    },
  },
});

export const logError = (message: string, error: Error | unknown) => {
  if (error instanceof Error) {
    logger.error({ message, error: error.message, stack: error.stack });
  } else {
    logger.error({ message, error });
  }
};

export const logInfo = (message: string, data?: any) => {
  logger.info({ message, data });
};

export const logDebug = (message: string, data?: any) => {
  logger.debug({ message, data });
};

export const logWarn = (message: string, data?: any) => {
  logger.warn({ message, data });
};

export default logger;
