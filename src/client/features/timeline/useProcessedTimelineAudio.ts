import { useEffect, useState } from 'react';
import type { WaveformPeaks } from '../../../core/peaks.js';
import { api } from '../../api.js';
import { t } from '../../i18n/index.js';
import { useStore } from '../../state/hooks.js';
import { processedTimelinePeaks, processedTimelineSource } from './processedTimelineAudio.js';

/** The exact processed montage, shared by all base clips, decoded once per receipt. */
export function useProcessedTimelineAudio(): { peaks: WaveformPeaks | null; status: string } {
  const state = useStore();
  const src = processedTimelineSource(
    state.project?.hasAudioComparison === true,
    state.audioPreviewOutdated,
    state.audioPreviewVersion,
    api.mediaUrl,
  );
  const [decoded, setDecoded] = useState<{ src: string; peaks: WaveformPeaks | null } | null>(null);
  const peaks = src !== null && decoded?.src === src ? decoded.peaks : null;
  const failed = src !== null && decoded?.src === src && decoded.peaks === null;
  const running =
    state.activeJobs.has('audio-preview') || state.audioPreviewRefreshState !== 'idle';
  const status = running
    ? t('timeline.baseAudio.updating')
    : state.audioPreviewError !== null || failed
      ? t('audio.audioPreview.waveformUnavailable')
      : state.audioPreviewOutdated
        ? t('timeline.baseAudio.outdated')
        : src === null
          ? t('timeline.baseAudio.original')
          : peaks === null
            ? t('audio.audioPreview.waveformLoading')
            : t('timeline.baseAudio.current');

  useEffect(() => {
    if (src === null) return;
    const controller = new AbortController();
    let disposed = false;
    const load = async (): Promise<void> => {
      let context: AudioContext | null = null;
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error('Audio preview unavailable');
        context = new AudioContext();
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
          buffer.getChannelData(i),
        );
        const next = processedTimelinePeaks(channels, buffer.sampleRate);
        if (!disposed) setDecoded({ src, peaks: next });
      } catch {
        if (!disposed) setDecoded({ src, peaks: null });
      } finally {
        if (context !== null) void context.close();
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [src]);

  return { peaks, status };
}
