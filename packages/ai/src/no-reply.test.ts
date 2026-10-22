import { describe, expect, it } from 'vitest';
import { noReplyNeeded } from './no-reply';

describe('noReplyNeeded', () => {
  it.each(['Thanks!', 'thank you so much 🙏', 'ok', 'OK thanks', 'Great, thank you!', 'got it 👍', 'Perfect.', 'cheers', 'Many thanks!!'])('skips the acknowledgement %j', (t) => {
    expect(noReplyNeeded(t)).toBe('acknowledgement');
  });
  it.each(['👍', '❤️❤️', '😂😂😂', '🙏🏽', '👍!'])('skips the emoji-only message %j', (t) => {
    expect(noReplyNeeded(t)).toBe('emoji_only');
  });
  it.each([
    'thanks, when do you open?', 'ok?', 'Yes', 'no', 'sure', 'hi', 'Hello!', 'ok do it', 'thanks but the cake was stale',
    'Do you deliver to Kentish Town?', 'great price, can I book for 4 people', '2', '', '   ', '!!!', 'ok '.repeat(30),
  ])('keeps %j for the AI', (t) => {
    expect(noReplyNeeded(t)).toBeNull();
  });
});
