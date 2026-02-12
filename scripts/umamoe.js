import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { syncUsers } from "./sheets.js"; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serversPath = path.join(__dirname, "..", "assets", "servers.json");
const usersPath   = path.join(__dirname, "..", "assets", "users.json");

export async function updateFansFromUmaMoe() {
  console.log("[UmaMoe] Starting daily fan update");

  const servers = JSON.parse(fs.readFileSync(serversPath, "utf8"));
  const users   = JSON.parse(fs.readFileSync(usersPath, "utf8"));

  let changed = false;

  for (const server of servers) {
    if (!server.umamoe_link) continue;

    console.log(`[UmaMoe] Fetching ${server.name}`);

    let data;
    try {
      const res = await fetch(server.umamoe_link);
      data = await res.json();
    } catch (err) {
      console.error(`[UmaMoe] Fetch failed: ${server.name}`, err);
      continue;
    }

    for (const member of data.members ?? []) {
      if (!Array.isArray(member.daily_fans)) continue;

      const maxFans = Math.max(...member.daily_fans);
      if (maxFans <= 0) continue;

      const user = users.find(
        u =>
          u.name === member.trainer_name &&
          u.club === server.name
      );

      if (!user) continue;

      const oldFans = Number(user.fans_total || 0);

      if (maxFans > oldFans) {
        user.fans_total = String(maxFans);
        changed = true;

        console.log(
          `[UmaMoe] ${user.name} (${server.name}) ${oldFans} → ${maxFans}`
        );
      }
    }
  }

  if (changed) {
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    await syncUsers();
    console.log("[UmaMoe] users.json updated");
  } else {
    console.log("[UmaMoe] No changes detected");
  }
}
