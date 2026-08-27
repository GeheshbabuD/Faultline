import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DraftStore, EMPTY_DRAFT } from './draft-store';

describe('DraftStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('starts empty when there is nothing saved', () => {
    const store = new DraftStore('problem-a');
    expect(store.getSnapshot()).toEqual(EMPTY_DRAFT);
    expect(store.hasContent()).toBe(false);
  });

  it('records responses per step', () => {
    const store = new DraftStore('problem-a');
    store.setResponse(0, 'It starts at -3');
    store.setResponse(1, 'Add 7');

    expect(store.getSnapshot().responses).toEqual({
      0: 'It starts at -3',
      1: 'Add 7',
    });
    expect(store.hasContent()).toBe(true);
  });

  it('returns a new snapshot object on change, so React re-renders', () => {
    const store = new DraftStore('problem-a');
    const before = store.getSnapshot();
    store.setResponse(0, 'something');
    expect(store.getSnapshot()).not.toBe(before);
  });

  it('returns the same snapshot reference when nothing changed', () => {
    const store = new DraftStore('problem-a');
    store.setResponse(0, 'something');
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const store = new DraftStore('problem-a');
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setResponse(0, 'a');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setResponse(0, 'b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('counts revisions separately from responses', () => {
    const store = new DraftStore('problem-a');
    store.setResponse(2, 'first thought');
    store.markRevised(2);
    store.markRevised(2);

    expect(store.getSnapshot().revisions[2]).toBe(2);
    expect(store.getSnapshot().responses[2]).toBe('first thought');
  });

  it('persists to storage and restores on a later visit', async () => {
    vi.useFakeTimers();
    const store = new DraftStore('problem-b');
    store.setResponse(0, 'saved reasoning');
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    const restored = new DraftStore('problem-b');
    expect(restored.getSnapshot().responses[0]).toBe('saved reasoning');
  });

  it('keeps drafts for different problems apart', async () => {
    vi.useFakeTimers();
    const first = new DraftStore('problem-one');
    first.setResponse(0, 'one');
    const second = new DraftStore('problem-two');
    second.setResponse(0, 'two');
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(new DraftStore('problem-one').getSnapshot().responses[0]).toBe('one');
    expect(new DraftStore('problem-two').getSnapshot().responses[0]).toBe('two');
  });

  it('clears the draft after a successful submission', async () => {
    vi.useFakeTimers();
    const store = new DraftStore('problem-c');
    store.setResponse(0, 'to be cleared');
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    store.clear();

    expect(store.getSnapshot()).toEqual(EMPTY_DRAFT);
    expect(new DraftStore('problem-c').getSnapshot().responses[0]).toBeUndefined();
  });

  it('survives corrupt stored data rather than breaking the session', () => {
    window.localStorage.setItem('faultline:draft:problem-d', '{not valid json');
    expect(new DraftStore('problem-d').getSnapshot()).toEqual(EMPTY_DRAFT);
  });

  it('ignores stored entries of the wrong shape', () => {
    window.localStorage.setItem(
      'faultline:draft:problem-e',
      JSON.stringify({ responses: { 0: 42, 1: 'valid' }, revisions: { 0: 'nope' } }),
    );
    const snapshot = new DraftStore('problem-e').getSnapshot();
    expect(snapshot.responses[0]).toBeUndefined();
    expect(snapshot.responses[1]).toBe('valid');
    expect(snapshot.revisions[0]).toBeUndefined();
  });

  it('keeps working when storage writes are blocked', async () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    vi.useFakeTimers();
    const store = new DraftStore('problem-f');
    store.setResponse(0, 'still editable');
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    // The in-memory draft is unaffected; only persistence was lost.
    expect(store.getSnapshot().responses[0]).toBe('still editable');
    setItem.mockRestore();
  });

  it('serves the empty draft as the server snapshot, so hydration matches', () => {
    const store = new DraftStore('problem-g');
    store.setResponse(0, 'client only');
    expect(store.getServerSnapshot()).toEqual(EMPTY_DRAFT);
  });
});
