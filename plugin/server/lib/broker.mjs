// The share server a book shares through. The plugin comes set to the public one; a book may name its own in
// book.json settings.shareBroker (https, or one on this machine for trying out wrangler dev).
export const DEFAULT_SHARE_BROKER = 'https://specbook.jasonrowland.com';

const BROKER = /^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/?$/;

// The broker for these book settings, or null when the book names one that is not a valid address.
export function shareBrokerOf(settings) {
  const url = settings?.shareBroker;
  if (url === undefined || url === null || url === '') {
    return DEFAULT_SHARE_BROKER;
  }
  return typeof url === 'string' && BROKER.test(url) ? url.replace(/\/+$/, '') : null;
}
