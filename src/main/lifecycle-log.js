const fs = require('node:fs');
const path = require('node:path');

// Local, bounded lifecycle metadata only. Callers must never pass clipboard/snippet payloads.
function createLifecycleLog(file, maxBytes = 256 * 1024) {
  return (event, details = {}) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n', { mode: 0o600 });
    } catch (_) {
      // Diagnostics must not terminate the app (full disk, permissions, etc.).
    }
  };
}
function errorMetadata(error) {
  // Exclude messages: storage/JSON errors can embed user content in their message.
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : undefined,
    frames: typeof error?.stack === 'string' ? error.stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 8) : [],
  };
}
module.exports = { createLifecycleLog, errorMetadata };
