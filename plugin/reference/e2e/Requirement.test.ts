import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RequirementLog } from './Requirement.js';

const SOURCE = `
await requirement('ONB-AAAA', 'First.', async () => {});
await requirement('ONB-BBBB', 'Second.', async () => {});
await requirement('ONB-CCCC', 'Third.', async () => {});
`;

function setup(clock: { t: number }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'requirement-'));
  const bookDir = path.join(dir, 'book');
  const resultsDir = path.join(dir, 'results');
  mkdirSync(path.join(bookDir, 'media', 'e2e'), { recursive: true });
  const log = new RequirementLog(
    'onboarding',
    1_000_000,
    {
      bookDir,
      resultsDir,
      now: () => clock.t,
      screenshot: file => {
        writeFileSync(file, 'png');
        return Promise.resolve();
      },
    },
    SOURCE
  );
  const result = () =>
    JSON.parse(readFileSync(path.join(resultsDir, 'onboarding.json'), 'utf8')) as {
      chapter: string;
      video: string;
      blocks: {
        id: string;
        start: number | null;
        end: number | null;
        status: string;
        screenshot: string | null;
        error: string | null;
      }[];
    };
  return { log, bookDir, result };
}

it('times a block relative to the recording start', async () => {
  const clock = { t: 1_002_000 };
  const { log, result } = setup(clock);
  await log.run('ONB-AAAA', 'First.', () => {
    clock.t = 1_004_500;
    return Promise.resolve();
  });
  const block = result().blocks[0];
  expect(block).toMatchObject({ id: 'ONB-AAAA', start: 2, end: 4.5, status: 'passed', screenshot: null, error: null });
  expect(result().video).toBe('media/e2e/onboarding.mov');
});

it('saves a screenshot on a pass only when asked', async () => {
  const { log, bookDir, result } = setup({ t: 1_000_000 });
  await log.run('ONB-AAAA', 'First.', () => Promise.resolve(), { screenshot: true });
  await log.run('ONB-BBBB', 'Second.', () => Promise.resolve());
  expect(existsSync(path.join(bookDir, 'media/e2e/ONB-AAAA.png'))).toBe(true);
  expect(existsSync(path.join(bookDir, 'media/e2e/ONB-BBBB.png'))).toBe(false);
  expect(result().blocks[0]?.screenshot).toBe('media/e2e/ONB-AAAA.png');
});

it('records a failure with its screenshot and message, and rethrows', async () => {
  const { log, bookDir, result } = setup({ t: 1_000_000 });
  await expect(log.run('ONB-AAAA', 'First.', () => Promise.reject(new Error('no logo')))).rejects.toThrow('no logo');
  expect(existsSync(path.join(bookDir, 'media/e2e/ONB-AAAA.failed.png'))).toBe(true);
  expect(result().blocks[0]).toMatchObject({
    status: 'failed',
    error: 'no logo',
    screenshot: 'media/e2e/ONB-AAAA.failed.png',
  });
});

it('writes every block after a failure as not_run, and does not run it', async () => {
  const { log, result } = setup({ t: 1_000_000 });
  await expect(log.run('ONB-AAAA', 'First.', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  let ran = false;
  await expect(
    log.run('ONB-BBBB', 'Second.', () => {
      ran = true;
      return Promise.resolve();
    })
  ).rejects.toThrow('did not run');
  expect(ran).toBe(false);
  expect(result().blocks.map(block => [block.id, block.status])).toEqual([
    ['ONB-AAAA', 'failed'],
    ['ONB-BBBB', 'not_run'],
    ['ONB-CCCC', 'not_run'],
  ]);
});

it('lists a declared requirement the file never reached as not_run', async () => {
  const { log, result } = setup({ t: 1_000_000 });
  await log.run('ONB-AAAA', 'First.', () => Promise.resolve());
  expect(result().blocks.map(block => [block.id, block.status])).toEqual([
    ['ONB-AAAA', 'passed'],
    ['ONB-BBBB', 'not_run'],
    ['ONB-CCCC', 'not_run'],
  ]);
});

it('deletes a stale failure screenshot when the block passes', async () => {
  const { log, bookDir } = setup({ t: 1_000_000 });
  const stale = path.join(bookDir, 'media/e2e/ONB-AAAA.failed.png');
  writeFileSync(stale, 'old');
  await log.run('ONB-AAAA', 'First.', () => Promise.resolve());
  expect(existsSync(stale)).toBe(false);
});

it('finds declarations written with double quotes, and records no video when none was copied', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'requirement-'));
  const log = new RequirementLog(
    'onboarding',
    0,
    { bookDir: dir, resultsDir: dir, screenshot: () => Promise.resolve() },
    `requirement('ONB-AAAA', "Someone's first.", async () => {});`
  );
  log.finish(path.join(dir, 'missing.mov'));
  const result = JSON.parse(readFileSync(path.join(dir, 'onboarding.json'), 'utf8')) as {
    video: string | null;
    blocks: { id: string; title: string; status: string }[];
  };
  expect(result.video).toBeNull();
  expect(result.blocks).toMatchObject([{ id: 'ONB-AAAA', title: "Someone's first.", status: 'not_run' }]);
});
