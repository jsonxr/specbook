// In a project this is the path to its copy of Requirement.ts, e.g. '../../src/Requirement.js'.
import { requirement } from './Requirement.js';

// The project's own driver and fixtures.
declare const app: { start(): Promise<void>; tapText(t: string): Promise<void>; waitForText(t: string): Promise<void> };
declare const ADA_EMAIL: string;

/**
 * Chapter "Profile and settings". One block per requirement, in book order. The block's title says what
 * it proves; its body asserts only that requirement, on screen. `screenshot: true` for a requirement with
 * something to see; a failure is always screenshotted.
 */
beforeAll(async () => {
  await app.start(); // seed through the API, sign in, land on the first screen
});

test('the profile screen', async () => {
  await requirement('PRO-4K2M', 'the profile button opens Profile as a sheet with Done', async () => {
    await app.tapText('Profile');
    await app.waitForText('Done');
  }, { screenshot: true });

  // A later block needs no setup of its own: the file is one recording, read top to bottom.
  await requirement('PRO-9QX2', 'Profile shows your name and email', async () => {
    await app.waitForText('Ada Admin');
    await app.waitForText(ADA_EMAIL);
  }, { screenshot: true });
});
