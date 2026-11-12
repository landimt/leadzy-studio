import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('update save acknowledgement', () => {
  it.each([
    ['saved', () => true, true],
    ['failed', () => false, false],
    ['rejected', () => Promise.reject(new Error('disk full')), false],
  ])('reports %s persistence accurately', async (_label, save, expected) => {
    let bridge;
    let flush;
    const send = vi.fn();
    vm.runInNewContext(readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8'), {
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            bridge = value;
          },
        },
        ipcRenderer: {
          on: (_channel, handler) => {
            flush = handler;
          },
          send,
        },
      }),
    });
    bridge.onFlushSaveRequest(save);
    flush();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('desktop:flush-save-done', { ok: expected }),
    );
  });
});
