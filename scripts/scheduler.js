import cron from "node-cron";
import { updateFansFromUmaMoe } from "./umamoe.js";

updateFansFromUmaMoe();

cron.schedule(
  "10 0 * * *",
  () => {
    console.log("[UmaMoe] Running UMA MOE sync");
    updateFansFromUmaMoe();
  },
  {
    timezone: "Asia/Tokyo"
  }
);