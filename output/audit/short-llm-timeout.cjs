// Isolated audit runtime only: keep production's 180-second LLM timeout, but
// make the timeout regression finish quickly without changing application code.
const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
const fs = require('node:fs');
const path = require('node:path');
const liveMarker = path.resolve(__dirname, '../../.anilearn/books-live-smoke');
AbortSignal.timeout = (milliseconds) => originalTimeout(milliseconds === 180_000 && !fs.existsSync(liveMarker) ? 5_000 : milliseconds);
