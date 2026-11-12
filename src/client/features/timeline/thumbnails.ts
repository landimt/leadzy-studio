import { useEffect, useState } from 'react';

const THUMB_WIDTH = 56;
const THUMB_HEIGHT = 100;

const cache = new Map<string, string>();
const videos = new Map<string, HTMLVideoElement>();
const queues = new Map<string, Promise<void>>();

function videoFor(url: string): HTMLVideoElement {
  let video = videos.get(url);
  if (!video) {
    video = document.createElement('video');
    video.src = url;
    video.preload = 'auto';
    video.muted = true;
    videos.set(url, video);
  }
  return video;
}

async function capture(url: string, timeS: number): Promise<string> {
  const key = `${url}@${timeS.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // one seek at a time per source video — parallel seeks cancel each other
  const previous = queues.get(url) ?? Promise.resolve();
  const work = previous.then(
    () =>
      new Promise<string>((resolve) => {
        const video = videoFor(url);
        const done = (): void => {
          const canvas = document.createElement('canvas');
          canvas.width = THUMB_WIDTH;
          canvas.height = THUMB_HEIGHT;
          const context = canvas.getContext('2d');
          if (context && video.videoWidth > 0) {
            const scale = Math.max(
              THUMB_WIDTH / video.videoWidth,
              THUMB_HEIGHT / video.videoHeight,
            );
            const w = video.videoWidth * scale;
            const h = video.videoHeight * scale;
            context.drawImage(video, (THUMB_WIDTH - w) / 2, (THUMB_HEIGHT - h) / 2, w, h);
          }
          const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          cache.set(key, dataUrl);
          resolve(dataUrl);
        };
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = timeS;
      }),
  );
  queues.set(
    url,
    work.then(() => undefined),
  );
  return work;
}

/** Frame thumbnails for a block: resolves progressively as frames are grabbed. */
export function useThumbnails(
  url: string | undefined,
  from: number,
  to: number,
  widthPx: number,
): string[] {
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    if (!url || widthPx < THUMB_WIDTH) {
      setThumbs([]);
      return;
    }
    const count = Math.max(1, Math.floor(widthPx / THUMB_WIDTH));
    const step = (to - from) / count;
    const times = Array.from({ length: count }, (_, i) => from + step * (i + 0.5));
    let cancelled = false;
    const loaded = new Array<string>(count).fill('');
    times.forEach((timeS, i) => {
      void capture(url, timeS).then((dataUrl) => {
        if (cancelled) return;
        loaded[i] = dataUrl;
        setThumbs([...loaded]);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [url, from, to, widthPx]);
  return thumbs;
}
