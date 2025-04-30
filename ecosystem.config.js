module.exports = {
  apps: [
    {
      name: "wtsapi.microservice",
      script: "yarn start:prod",
      max_memory_restart: "450M",
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "DD-MM-YYYY HH:mm:ss",
    },
  ],
};