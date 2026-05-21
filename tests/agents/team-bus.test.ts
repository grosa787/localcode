/**
 * TeamBus tests — pub/sub semantics, ring-buffer cap, sender filtering,
 * recipient filtering, since-cursor, subscribers.
 */

import { describe, expect, test } from 'bun:test';

import { TeamBus, DEFAULT_BUS_CAPACITY } from '@/agents/team-bus';

describe('TeamBus', () => {
  test('send + read returns broadcasts addressed to caller', async () => {
    const bus = new TeamBus();
    const t0 = Date.now();
    bus.send({ from: 'lead', to: 'all', message: 'plan' });
    // Tiny await to ensure `at > sinceMs(=t0-1)` filter matches.
    await new Promise((r) => setTimeout(r, 2));
    const msgs = bus.read('worker-1', t0 - 1);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.message).toBe('plan');
  });

  test('read excludes the caller’s own messages', () => {
    const bus = new TeamBus();
    bus.send({ from: 'worker-1', to: 'all', message: 'hi' });
    const msgs = bus.read('worker-1', 0);
    expect(msgs.length).toBe(0);
  });

  test('unicast: only addressed recipient sees the message', () => {
    const bus = new TeamBus();
    bus.send({ from: 'lead', to: 'worker-1', message: 'private' });
    expect(bus.read('worker-1', 0).length).toBe(1);
    expect(bus.read('worker-2', 0).length).toBe(0);
  });

  test('sinceMs cursor filters out earlier messages', async () => {
    const bus = new TeamBus();
    bus.send({ from: 'lead', to: 'all', message: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    const cursor = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    bus.send({ from: 'lead', to: 'all', message: 'second' });
    const msgs = bus.read('worker-1', cursor);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.message).toBe('second');
  });

  test('ring-buffer caps history at the configured capacity', () => {
    const bus = new TeamBus({ capacity: 3 });
    bus.send({ from: 'lead', to: 'all', message: 'a' });
    bus.send({ from: 'lead', to: 'all', message: 'b' });
    bus.send({ from: 'lead', to: 'all', message: 'c' });
    bus.send({ from: 'lead', to: 'all', message: 'd' });
    const hist = bus.history();
    expect(hist.length).toBe(3);
    expect(hist[0]?.message).toBe('b');
    expect(hist[2]?.message).toBe('d');
  });

  test('default capacity is 1000', () => {
    expect(DEFAULT_BUS_CAPACITY).toBe(1000);
  });

  test('subscribe receives every send and unsubscribe stops delivery', () => {
    const bus = new TeamBus();
    const seen: string[] = [];
    const unsub = bus.subscribe((m) => seen.push(m.message));
    bus.send({ from: 'lead', to: 'all', message: 'one' });
    bus.send({ from: 'lead', to: 'worker-1', message: 'two' });
    expect(seen).toEqual(['one', 'two']);
    unsub();
    bus.send({ from: 'lead', to: 'all', message: 'three' });
    expect(seen).toEqual(['one', 'two']);
  });

  test('clear drops history and subscribers', () => {
    const bus = new TeamBus();
    let count = 0;
    bus.subscribe(() => {
      count += 1;
    });
    bus.send({ from: 'lead', to: 'all', message: 'x' });
    expect(count).toBe(1);
    bus.clear();
    expect(bus.size()).toBe(0);
    bus.send({ from: 'lead', to: 'all', message: 'y' });
    expect(count).toBe(1); // subscriber gone
  });

  test('throwing subscriber does not break the bus', () => {
    const bus = new TeamBus();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    let saw = 0;
    bus.subscribe(() => {
      saw += 1;
    });
    bus.send({ from: 'lead', to: 'all', message: 'x' });
    expect(saw).toBe(1);
  });
});
