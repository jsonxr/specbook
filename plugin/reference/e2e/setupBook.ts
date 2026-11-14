import path from 'node:path';
import { RequirementLog } from './Requirement.js';

/**
 * A test-runner setup file (Vitest `setupFiles`, run once per test file). A file under `tests/book/` is a
 * specbook chapter: it is recorded, its requirement blocks are timed against that recording, and the
 * recording is copied into the book when the file ends.
 *
 * Replace `recorder` and `screenshot` with the project's own: the recorder must expose the wall time of
 * the recording's first frame (`startedAt`, ms) and the path it wrote (`output`).
 * Vitest: set `sequence.hooks: 'list'` so this afterAll runs before the file's own cleanup can skip it.
 */
declare const recorder: { start(name: string): Promise<void>; stop(): Promise<void>; startedAt: number; output: string };
declare const screenshot: (file: string) => Promise<void>;

const BOOK_DIR = path.join('tests', 'book') + path.sep;

beforeAll(async suite => {
  await recorder.start(suite.name);
  if (suite.name.startsWith(BOOK_DIR)) {
    RequirementLog.begin(suite.name, recorder.startedAt, screenshot);
  }
});

afterAll(async () => {
  await recorder.stop();
  RequirementLog.current?.finish(recorder.output);
  RequirementLog.end();
});
