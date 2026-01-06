import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://9766369ce1ce66e2f7bb47ad6d4fc8f5@o4507509902606336.ingest.us.sentry.io/4509924424482816",
  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
  enabled: true,
});
