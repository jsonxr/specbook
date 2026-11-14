import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Status = 'passed' | 'failed' | 'not_run';

interface Block {
  id: string;
  title: string;
  start: number | null;
  end: number | null;
  status: Status;
  screenshot: string | null;
  error: string | null;
}

interface Options {
  /** Where `docs/specbook` is. */
  bookDir?: string;
  /** Where the chapter's result file goes. */
  resultsDir?: string;
  /** Takes the screenshot. */
  screenshot: (file: string) => Promise<void>;
  now?: () => number;
}

// Adjust both to where this file sits in the project.
const REPO_BOOK_DIR = fileURLToPath(new URL('../../../docs/specbook', import.meta.url));
const REPO_RESULTS_DIR = fileURLToPath(new URL('../results/book', import.meta.url));
const MEDIA = 'media/e2e';
const DECLARATION = /requirement\(\s*['"]([A-Z]+-[A-Z0-9]+)['"]\s*,\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g;

/**
 * What one book chapter's test file proved, with the time range of each proof in
 * the chapter's recording. Written to `results/book/<chapter>.json`, which the
 * spec book's evidence collector reads. A block after a failure does not run: it
 * is recorded as `not_run`, as is any requirement the file names but never reached.
 */
export class RequirementLog {
  static #current: RequirementLog | undefined;

  static get current(): RequirementLog | undefined {
    return RequirementLog.#current;
  }

  /** Starts the log for a chapter's test file. `startedAt` is the wall time of the recording's first frame. */
  static begin(testFile: string, startedAt: number, screenshot: (file: string) => Promise<void>): RequirementLog {
    const log = new RequirementLog(
      path.basename(testFile).replace(/\.test\.ts$/, ''),
      startedAt,
      { screenshot },
      readFileSync(testFile, 'utf8')
    );
    RequirementLog.#current = log;
    return log;
  }

  static end(): void {
    RequirementLog.#current = undefined;
  }

  readonly #chapter: string;
  readonly #startedAt: number;
  readonly #options: Options;
  readonly #source: string;
  readonly #blocks: Block[] = [];
  #failed = false;
  #hasVideo = true;

  constructor(chapter: string, startedAt: number, options: Options, source = '') {
    this.#chapter = chapter;
    this.#startedAt = startedAt;
    this.#options = options;
    this.#source = source;
  }

  async run(id: string, title: string, fn: () => Promise<void>, opts: { screenshot?: boolean } = {}): Promise<void> {
    if (this.#failed) {
      this.#blocks.push(this.#block(id, title, 'not_run', null, null, null, null));
      this.write();
      throw new Error(`${id} did not run: an earlier requirement in ${this.#chapter} failed`);
    }

    const failedFile = this.#file(`${id}.failed.png`);
    const start = this.#seconds();
    try {
      await fn();
    } catch (error) {
      const end = this.#seconds();
      this.#failed = true;
      const saved = await this.#capture(failedFile);
      const message = error instanceof Error ? error.message : String(error);
      this.#blocks.push(
        this.#block(id, title, 'failed', start, end, saved ? `${MEDIA}/${id}.failed.png` : null, message)
      );
      this.write();
      throw error;
    }
    const end = this.#seconds();
    rmSync(failedFile, { force: true });
    let screenshot: string | null = null;
    if (opts.screenshot === true && (await this.#capture(this.#file(`${id}.png`)))) {
      screenshot = `${MEDIA}/${id}.png`;
    }
    this.#blocks.push(this.#block(id, title, 'passed', start, end, screenshot, null));
    this.write();
  }

  /** Writes the result file. Run after every block so a crash still leaves what was proven. */
  write(): void {
    const resultsDir = this.#options.resultsDir ?? REPO_RESULTS_DIR;
    mkdirSync(resultsDir, { recursive: true });
    const result = {
      chapter: this.#chapter,
      video: this.#hasVideo ? `${MEDIA}/${this.#chapter}.mov` : null,
      runAt: new Date(this.#now()).toISOString(),
      blocks: this.#withNotRun(),
    };
    writeFileSync(path.join(resultsDir, `${this.#chapter}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }

  /** Copies the recording to the book, then writes the final result file. */
  finish(recording: string): void {
    this.#hasVideo = existsSync(recording);
    if (this.#hasVideo) {
      const bookMedia = path.join(this.#options.bookDir ?? REPO_BOOK_DIR, MEDIA);
      mkdirSync(bookMedia, { recursive: true });
      copyFileSync(recording, path.join(bookMedia, `${this.#chapter}.mov`));
    }
    this.write();
  }

  /** The blocks that ran, in the order the file declares them, then a `not_run` for each declared one that never did. */
  #withNotRun(): Block[] {
    const ran = new Map(this.#blocks.map(block => [block.id, block]));
    const declared = [...this.#source.matchAll(DECLARATION)].map(match => ({
      id: match[1] ?? '',
      title: (match[3] ?? '').replaceAll(/\\(.)/g, '$1'),
    }));
    const ordered: Block[] = declared.map(
      ({ id, title }) => ran.get(id) ?? this.#block(id, title, 'not_run', null, null, null, null)
    );
    const declaredIds = new Set(declared.map(({ id }) => id));
    return [...ordered, ...this.#blocks.filter(block => !declaredIds.has(block.id))];
  }

  #block(
    id: string,
    title: string,
    status: Status,
    start: number | null,
    end: number | null,
    screenshot: string | null,
    error: string | null
  ): Block {
    return { id, title, start, end, status, screenshot, error };
  }

  /** False when the screenshot could not be taken, which must not hide the error that caused it. */
  async #capture(file: string): Promise<boolean> {
    try {
      await this.#options.screenshot(file);
      return true;
    } catch {
      return false;
    }
  }

  #file(name: string): string {
    return path.join(this.#options.bookDir ?? REPO_BOOK_DIR, MEDIA, name);
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #seconds(): number {
    return Math.round(((this.#now() - this.#startedAt) / 1000) * 100) / 100;
  }
}

/**
 * One proof of one specbook requirement. Records its time range in the chapter's
 * recording, and screenshots on success when asked, and always on failure.
 */
export async function requirement(
  id: string,
  title: string,
  fn: () => Promise<void>,
  opts?: { screenshot?: boolean }
): Promise<void> {
  const log = RequirementLog.current;
  if (!log) {
    await fn();
    return;
  }
  await log.run(id, title, fn, opts);
}
