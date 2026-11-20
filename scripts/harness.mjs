process.env.HOST = "127.0.0.1";
process.env.APP_DATA_DIR_SUFFIX ??= "forge-review";
process.env.OUTBOUND_URL_ALLOWED_HOSTS ??= '["127.0.0.1"]';
await import(new URL("../node_modules/@truefoundry/trueforge/dist/cli.js", import.meta.url));
