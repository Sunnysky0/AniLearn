// Isolated audit runtime only: keep production's 180-second LLM timeout, but
// make the timeout regression finish quickly without changing application code.
const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (milliseconds) => originalTimeout(milliseconds === 180_000 ? 5_000 : milliseconds);
