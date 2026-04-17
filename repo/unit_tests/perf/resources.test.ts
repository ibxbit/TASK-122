import { describe, expect, it } from 'vitest';
import {
  StatementCache, ImageBufferCache, ResourceRegistry,
  using, ResourceScope,
} from '../../src/main/resources/lifecycle';

/* =========================================================================
 *  Resource caches + scoped disposal + global registry.
 * ========================================================================= */

describe('StatementCache', () => {
  it('reuses prepared statements on hit', () => {
    const cache = new StatementCache({ maxEntries: 4 });
    let prepared = 0;
    const stub = () => ({ prepared: ++prepared } as any);

    const a = cache.get('SELECT 1', stub);
    const b = cache.get('SELECT 1', stub);
    expect(a).toBe(b);
    expect(prepared).toBe(1);
    expect(cache.size()).toBe(1);
  });

  it('evicts LRU when maxEntries exceeded', () => {
    const evictions: string[] = [];
    const cache = new StatementCache({ maxEntries: 2, onEvict: (s) => evictions.push(s) });
    cache.get('A', () => ({} as any));
    cache.get('B', () => ({} as any));
    cache.get('C', () => ({} as any));                // should evict A
    expect(cache.size()).toBe(2);
    expect(evictions).toEqual(['A']);
  });

  it('trim() reduces to target size', () => {
    const cache = new StatementCache({ maxEntries: 10 });
    for (let i = 0; i < 6; i++) cache.get(`S${i}`, () => ({} as any));
    const evicted = cache.trim(3);
    expect(cache.size()).toBe(3);
    expect(evicted).toBe(3);
  });

  it('clear() drops all entries', () => {
    const cache = new StatementCache();
    cache.get('A', () => ({} as any));
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('ImageBufferCache', () => {
  it('tracks byte usage + evicts LRU when over maxBytes', () => {
    const cache = new ImageBufferCache({ maxBytes: 100 });
    cache.set('a', Buffer.alloc(60));
    cache.set('b', Buffer.alloc(60));          // triggers eviction of 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.totalBytes()).toBe(60);
  });

  it('re-setting the same key accounts bytes correctly', () => {
    const cache = new ImageBufferCache();
    cache.set('a', Buffer.alloc(100));
    cache.set('a', Buffer.alloc(40));
    expect(cache.totalBytes()).toBe(40);
    expect(cache.size()).toBe(1);
  });

  it('trim() evicts until bytes ≤ target', () => {
    const cache = new ImageBufferCache({ maxBytes: 1_000 });
    cache.set('a', Buffer.alloc(300));
    cache.set('b', Buffer.alloc(300));
    cache.set('c', Buffer.alloc(300));
    cache.trim(400);
    expect(cache.totalBytes()).toBeLessThanOrEqual(400);
  });
});

describe('ResourceScope / using()', () => {
  it('disposes in LIFO order', async () => {
    const order: string[] = [];
    await using(async (scope: ResourceScope) => {
      scope.registerFn(() => { order.push('outer'); }, 'outer');
      scope.registerFn(() => { order.push('inner'); }, 'inner');
    });
    expect(order).toEqual(['inner', 'outer']);
  });

  it('runs dispose even when callback throws', async () => {
    const order: string[] = [];
    await expect(using(async (scope) => {
      scope.registerFn(() => { order.push('disposed'); });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(order).toEqual(['disposed']);
  });
});

describe('ResourceRegistry', () => {
  it('tracks and disposes entries by kind', async () => {
    const reg = new ResourceRegistry();
    let disposed = 0;
    reg.track({ kind: 'image-buffer', label: 'a', bytes: 10, dispose: () => { disposed++; } });
    reg.track({ kind: 'image-buffer', label: 'b', bytes: 20, dispose: () => { disposed++; } });
    reg.track({ kind: 'other',        label: 'c',              dispose: () => { disposed++; } });
    expect(reg.stats().totalCount).toBe(3);
    const n = await reg.disposeByKind('image-buffer');
    expect(n).toBe(2);
    expect(disposed).toBe(2);
    expect(reg.stats().totalCount).toBe(1);
  });
});
