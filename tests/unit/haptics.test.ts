// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { haptic, isHapticsSupported, PATTERNS } from '@/services/haptics';

describe('haptics 觸覺回饋', () => {
  const origVibrate = navigator.vibrate;

  afterEach(() => {
    Object.defineProperty(navigator, 'vibrate', { value: origVibrate, configurable: true, writable: true });
    delete (window as any).webkit;
  });

  it('支援 navigator.vibrate 時正確傳入樣式毫秒數', () => {
    const vibrateMock = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrateMock, configurable: true, writable: true });

    expect(isHapticsSupported()).toBe(true);
    haptic('medium');
    expect(vibrateMock).toHaveBeenCalledWith(PATTERNS.medium);
  });

  it('iOS Safari / 不支援震動時安全降級不報錯', () => {
    Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true, writable: true });

    expect(isHapticsSupported()).toBe(false);
    expect(() => haptic('selection')).not.toThrow();
  });

  it('支援 iOS WebKit messageHandler 轉發原生觸覺', () => {
    Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true, writable: true });
    const postMessageMock = vi.fn();
    (window as any).webkit = {
      messageHandlers: {
        haptics: {
          postMessage: postMessageMock,
        },
      },
    };

    expect(isHapticsSupported()).toBe(true);
    haptic('success');
    expect(postMessageMock).toHaveBeenCalledWith({ style: 'success' });
  });
});

