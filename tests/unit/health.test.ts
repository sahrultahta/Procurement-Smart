import { describe, expect, it } from 'vitest';
import { checkHealth } from '@/modules/health';

describe('checkHealth', () => {
  it('reports ok when the database answers', async () => {
    await expect(checkHealth(async () => true)).resolves.toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('reports unavailable when the database does not answer', async () => {
    await expect(checkHealth(async () => false)).resolves.toEqual({
      status: 'unavailable',
      checks: { database: 'unavailable' },
    });
  });
});
