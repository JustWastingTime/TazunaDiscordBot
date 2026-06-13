import { closeDueEvents } from './eventService.js';

const TICK_MS = 60 * 1000;
let tickInFlight = false;

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const closed = await closeDueEvents();
    if (closed.length) {
      console.log(
        `Auto-closed event(s): ${closed.map((event) => `${event.id} ${event.name}`).join(', ')}`,
      );
    }
  } catch (err) {
    console.error('Event auto-close tick failed:', err.message);
  } finally {
    tickInFlight = false;
  }
}

export function startEventCron() {
  setInterval(() => {
    tick().catch((err) => {
      console.error('Event cron tick error:', err.message);
    });
  }, TICK_MS);
}
