import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';

const budget = {settleMs: 5000, sampleMs: 50, stableSamples: 6, tolerance: 2};

/** Exercise the real shell with an already selected, idle worker whose history
 * exceeds two screens. Accept a Playwright page (or the in-app browser's
 * Playwright surface). Only navigate and read DOM; never send or alter research.
 * A presenter-only fixture cannot catch missing shell visibility propagation. */
export async function verifyWorkerReading(page) {
  const history = page.getByLabel('Conversation history', {exact: true});
  const read = async () => {
    const deadline = Date.now() + budget.settleMs;
    let previous = '', stable = 0;
    while (Date.now() < deadline) {
      const value = await history.evaluate(host => {
        const top = host.getBoundingClientRect().top;
        const row = [...host.querySelectorAll('[data-chat-row]')].find(row => row.getBoundingClientRect().bottom > top);
        return {
          scroll: host.scrollTop,
          bottom: host.scrollHeight - host.scrollTop - host.clientHeight,
          height: host.clientHeight,
          anchor: row ? {key: row.dataset.chatRow, offset: row.getBoundingClientRect().top - top} : null,
        };
      });
      const current = JSON.stringify(value);
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (value.height && value.anchor && stable >= budget.stableSamples) return value;
      await pause(budget.sampleMs);
    }
    throw new Error('Conversation geometry did not settle');
  };
  const results = [];
  const roundTrip = async (destination, returnTo, expected, tail = false) => {
    await page.getByRole('button', {name: destination, exact: true}).click();
    assert.equal(await history.isVisible(), false, `${destination} must hide the conversation`);
    await page.getByRole('button', {name: returnTo, exact: true}).click();
    const actual = await read();
    if (tail) assert.ok(Math.abs(actual.bottom) <= budget.tolerance, `${destination} lost the tail`);
    else {
      assert.equal(actual.anchor.key, expected.anchor.key, `${destination} changed the visible message`);
      assert.ok(Math.abs(actual.anchor.offset - expected.anchor.offset) <= budget.tolerance,
        `${destination} displaced the reading position: ${JSON.stringify({expected, actual})}`);
    }
    results.push({destination, tail, before: expected, after: actual});
  };

  await history.press('End');
  const tail = await read();
  assert.ok(tail.scroll > tail.height * 2, 'Use a conversation with more than two screens of history');
  await roundTrip('Environment', 'Project', tail, true);
  await roundTrip('Settings', 'Project', await read(), true);

  await history.press('PageUp');
  await read();
  await history.press('PageUp');
  const reading = await read();
  assert.ok(reading.scroll > 0 && reading.bottom > reading.height, 'The regression needs a middle reading position');
  for (const destination of ['Environment', 'Environment', 'Settings']) {
    await roundTrip(destination, 'Project', reading);
  }
  await roundTrip('Trajectory', 'Conversation', reading);
  return results;
}
