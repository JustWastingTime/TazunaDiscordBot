import { closeDueSignups } from './signupHandlers.js';

const TICK_MS = 60 * 1000;
let tickInFlight = false;

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const closed = await closeDueSignups();
    if (closed.length) {
      console.log(
        `Auto-closed signup(s): ${closed.map((s) => `${s.id} ${s.name}`).join(', ')}`,
      );
    }
  } catch (err) {
    console.error('Signup auto-close tick failed:', err.message);
  } finally {
    tickInFlight = false;
  }
}

export function startSignupCron() {
  setInterval(() => {
    tick().catch((err) => {
      console.error('Signup cron tick error:', err.message);
    });
  }, TICK_MS);
}
