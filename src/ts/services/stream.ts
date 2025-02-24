import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import { PlatformConfig } from '../types';
import { FFmpegService } from './ffmpeg';
import { Logger, LogLevel } from '../utils';

export class StreamService {
  private ffmpeg!: typeof ffmpeg;
  private activeStreams: Map<string, FfmpegCommand>;
  private streamRetries: Record<string, Record<string, number>>;
  private stoppingStreams: Set<string>;  // Track streams that are being intentionally stopped
  private readonly maxRetries: number = 16;

  constructor() {
    this.activeStreams = new Map();
    this.streamRetries = {};
    this.stoppingStreams = new Set();

    // Initialize FFmpeg
    this.initFFmpeg();
  }

  private async initFFmpeg(): Promise<void> {
    this.ffmpeg = await FFmpegService.getInstance().getFFmpeg() as unknown as typeof ffmpeg;
  }

  async startPlatformStream(
    platform: string,
    config: PlatformConfig,
    inputUrl: string,
    streamPath: string
  ): Promise<FfmpegCommand | null> {
    try {
      // Don't start if stream is being stopped
      const streamKey = `${streamPath}-${platform}`;
      if (this.stoppingStreams.has(streamKey)) {
        Logger.log(LogLevel.INFO, `[${platform}] Stream ${streamPath} is being stopped, not starting`);
        return null;
      }

      const retryCount = this.getRetryCount(streamPath, platform);
      if (retryCount >= this.maxRetries) {
        Logger.log(LogLevel.INFO, `[${platform}] Max retry attempts reached for stream ${streamPath}`);
        return null;
      }

      const outputUrl = `${config.url}/${config.key}`;
      if (!outputUrl) {
        throw new Error(`[${platform}] Output URL is missing`);
      }

      const stream = this.ffmpeg()
        .input(inputUrl)
        .inputOptions(config.options.input)
        .output(outputUrl)
        .outputOptions(config.options.output);

      this.setupStreamHandlers(stream, platform, streamPath, config, inputUrl);
      stream.run();

      this.activeStreams.set(streamKey, stream);
      return stream;
    } catch (error) {
      Logger.log(LogLevel.ERROR, `[${platform}] Failed to initialize stream:`, error);
      return null;
    }
  }

  private setupStreamHandlers(
    stream: FfmpegCommand,
    platform: string,
    streamPath: string,
    config: PlatformConfig,
    inputUrl: string
  ): void {
    const streamKey = `${streamPath}-${platform}`;
    const retryCount = this.getRetryCount(streamPath, platform);

    stream
      .on('start', () => {
        Logger.log(LogLevel.INFO, `[${platform}] Streaming started (${config.url}/${config.key}) (Attempt ${retryCount + 1}/${this.maxRetries})`);
      })
      .on('error', (err, stdout, stderr) => {
        Logger.log(LogLevel.ERROR, `[${platform}] Stream error:`, err.message);
        if (stderr) Logger.log(LogLevel.ERROR, `[${platform}] FFmpeg stderr:`, stderr);

        // Only handle error if stream isn't being intentionally stopped
        if (!this.stoppingStreams.has(streamKey)) {
          this.handleStreamError(platform, streamPath, config, inputUrl);
        } else {
          Logger.log(LogLevel.INFO, `[${platform}] Stream was being stopped, ignoring error`);
          this.stoppingStreams.delete(streamKey);
        }
      })
      .on('end', () => {
        Logger.log(LogLevel.INFO, `[${platform}] Stream ended normally`);
        this.activeStreams.delete(streamKey);
        this.stoppingStreams.delete(streamKey);
      });
  }

  private handleStreamError(
    platform: string,
    streamPath: string,
    config: PlatformConfig,
    inputUrl: string
  ): void {
    const streamKey = `${streamPath}-${platform}`;

    if (this.activeStreams.has(streamKey)) {
      try {
        const oldStream = this.activeStreams.get(streamKey);
        oldStream?.kill('SIGINT');
        this.activeStreams.delete(streamKey);
      } catch (error) {
        Logger.log(LogLevel.ERROR, `[${platform}] Error killing stream:`, error);
      }
    }

    // Only retry if stream isn't being stopped
    if (!this.stoppingStreams.has(streamKey)) {
      this.incrementRetryCount(streamPath, platform);
      const retryCount = this.getRetryCount(streamPath, platform);

      if (retryCount <= this.maxRetries) {
        setTimeout(() => {
          // Double check stream isn't being stopped before retrying
          if (!this.stoppingStreams.has(streamKey)) {
            Logger.log(LogLevel.INFO, `[${platform}] Attempting to restart stream...`);
            this.startPlatformStream(platform, config, inputUrl, streamPath);
          }
        }, 5000);
      }
    }
  }

  private getRetryCount(streamPath: string, platform: string): number {
    return this.streamRetries[streamPath]?.[platform] || 0;
  }

  private incrementRetryCount(streamPath: string, platform: string): void {
    if (!this.streamRetries[streamPath]) {
      this.streamRetries[streamPath] = {};
    }
    if (!this.streamRetries[streamPath][platform]) {
      this.streamRetries[streamPath][platform] = 0;
    }
    this.streamRetries[streamPath][platform]++;
  }

  stopAllStreams(streamPath: string): void {
    for (const [streamKey, stream] of this.activeStreams.entries()) {
      if (streamKey.startsWith(`${streamPath}-`)) {
        try {
          const platform = streamKey.split('-')[1];
          Logger.log(LogLevel.INFO, `[${platform}] Killing stream for ${streamPath}`);
          // Mark stream as being stopped
          this.stoppingStreams.add(streamKey);
          stream.kill('SIGINT');
          this.activeStreams.delete(streamKey);
        } catch (error) {
          Logger.log(LogLevel.ERROR, `Error killing stream ${streamKey}:`, error);
          this.stoppingStreams.delete(streamKey);
        }
      }
    }
    delete this.streamRetries[streamPath];
  }

  stopStream(platform: string, streamPath: string): void {
    const streamKey = `${streamPath}-${platform}`;
    const stream = this.activeStreams.get(streamKey);

    if (stream) {
      try {
        Logger.log(LogLevel.INFO, `[${platform}] Killing stream for ${streamPath}`);
        this.stoppingStreams.add(streamKey);
        stream.kill('SIGINT');
        this.activeStreams.delete(streamKey);
      } catch (error) {
        Logger.log(LogLevel.ERROR, `Error killing stream ${streamKey}:`, error);
        this.stoppingStreams.delete(streamKey);
      }
    }
  }

  resetRetryCount(streamPath: string): void {
    if (this.streamRetries[streamPath]) {
      Object.keys(this.streamRetries[streamPath]).forEach(platform => {
        this.streamRetries[streamPath][platform] = 0;
      });
    }
  }

  public getActiveStreams(): Map<string, FfmpegCommand> {
    return this.activeStreams;
  }

  // New method to check if a stream is active
  public isStreamActive(platform: string, streamPath: string): boolean {
    return this.activeStreams.has(`${streamPath}-${platform}`);
  }
}