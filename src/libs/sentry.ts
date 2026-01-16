import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://f77c2884f37e3295d775b9696786bbeb@o4507509902606336.ingest.us.sentry.io/4510720568721408",
  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
});

