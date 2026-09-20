import puppeteer from 'puppeteer';
import { access, appendFile } from 'node:fs/promises';

// Puppeteer's executablePath is asynchronous. Never write its Promise's
// multi-line inspection output into GitHub's line-oriented environment file.
const executablePath = await puppeteer.executablePath();
if (typeof executablePath !== 'string' || /[\r\n]/.test(executablePath)) {
    throw new Error('Invalid test browser path');
}
await access(executablePath);
if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
await appendFile(process.env.GITHUB_ENV, `PUPPETEER_EXECUTABLE_PATH=${executablePath}\n`);
