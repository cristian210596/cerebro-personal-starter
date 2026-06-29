import { startTelegramPolling } from './telegram.js';

startTelegramPolling().catch(error => {
  console.error(error);
  process.exit(1);
});
