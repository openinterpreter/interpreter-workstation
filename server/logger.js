import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
const LOG_DIR = path.resolve(import.meta.dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
// Clear log file on startup
fs.writeFileSync(LOG_FILE, '');
function timestamp() {
    return new Date().toISOString();
}
function formatArgs(...args) {
    return args.map(arg => typeof arg === 'string' ? arg : util.inspect(arg, { depth: 10, colors: false })).join(' ');
}
function writeToFile(level, message) {
    const logLine = `[${timestamp()}] [${level}] ${message}\n`;
    try {
        fs.appendFileSync(LOG_FILE, logLine);
    }
    catch (err) {
        // Silent fail - don't create infinite loop
    }
}
// Store original console methods
const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug
};
// Override console methods to also write to file
console.log = function (...args) {
    const message = formatArgs(...args);
    originalConsole.log(...args);
    writeToFile('LOG', message);
};
console.error = function (...args) {
    const message = formatArgs(...args);
    originalConsole.error(...args);
    writeToFile('ERROR', message);
};
console.warn = function (...args) {
    const message = formatArgs(...args);
    originalConsole.warn(...args);
    writeToFile('WARN', message);
};
console.info = function (...args) {
    const message = formatArgs(...args);
    originalConsole.info(...args);
    writeToFile('INFO', message);
};
console.debug = function (...args) {
    const message = formatArgs(...args);
    originalConsole.debug(...args);
    writeToFile('DEBUG', message);
};
export const logger = {
    getLogPath() {
        return LOG_FILE;
    },
    clear() {
        fs.writeFileSync(LOG_FILE, '');
    }
};
//# sourceMappingURL=logger.js.map