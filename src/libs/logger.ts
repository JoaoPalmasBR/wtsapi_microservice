import pino from "pino"


const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export const logInfo = (message: string, ...args: any[]) => {
  logger.info({ msg: message, args });
}

export const logWarn = (message: string, ...args: any[]) => {
  logger.warn({ msg: message, args });
}

export const logError = (message: string, ...args: any[]) => {
  logger.error({ msg: message, args });
}



export default logger;