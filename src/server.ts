import { createApp } from "./app.js";
import { appConfig } from "./config.js";

const app = createApp();

app.listen(appConfig.port, () => {
  console.log(`WeChat Article Pilot is running at http://localhost:${appConfig.port}`);
});
