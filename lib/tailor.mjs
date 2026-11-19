import { execFile } from 'node:child_process';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function renderResumePdf(html, outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  const tmp = outPath.replace(/\.pdf$/i, '.html');
  await writeFile(tmp, html, 'utf8');
  const profile = join(tmpdir(), 'job-radar-chrome');
  await mkdir(profile, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=1500',
      '--no-pdf-header-footer',
      `--print-to-pdf=${outPath}`,
      'file://' + tmp,
    ], { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });
  await unlink(tmp).catch(() => {});
  return outPath;
}
