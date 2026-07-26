import { processDueMineAlarms } from './mineAlarmService.js';

const TICK_MS = 30 * 1000;
let tickInFlight = false;

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await processDueMineAlarms();
  } catch (err) {
    console.error('Mine alarm tick failed:', err.message);
  } finally {
    tickInFlight = false;
  }
}

export function startMineAlarmCron() {
  setInterval(() => {
    tick().catch((err) => {
      console.error('Mine alarm cron tick error:', err.message);
    });
  }, TICK_MS);
}
