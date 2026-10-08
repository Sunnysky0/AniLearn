// IPC requests let Next run its own signal cleanup before the supervisor's bounded fallback.
process.on('message', message => {
  if (message?.type === 'stop') process.emit('SIGINT', 'SIGINT');
});
process.argv = [process.execPath, require.resolve('next/dist/bin/next'), ...process.argv.slice(2)];
require('next/dist/bin/next');
