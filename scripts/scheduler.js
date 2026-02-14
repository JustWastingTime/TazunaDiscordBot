import cron from "node-cron";
import { updateFansFromUmaMoe } from "./umamoe.js";

console.log("[UmaMoe] Running UMA MOE sync on startup");
updateFansFromUmaMoe();

cron.schedule(
  "12 22 * * *",
  () => {
    console.log("[UmaMoe] Running UMA MOE sync auto daily");
    updateFansFromUmaMoe();
  },
  {
    timezone: "Asia/Jakarta"
  }
);