module.exports = {
  apps: [
    {
      name: "wtsapi.microservice",
      script: "pnpm start:prod",
      max_memory_restart: "550M",
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "DD-MM-YYYY HH:mm:ss",
    },
  ],
};