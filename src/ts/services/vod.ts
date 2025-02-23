import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import { VodConfig, RecordingMetadata, StreamIndex, RecordingFormat } from '../types';
import { sanitizeRecordingsIndex } from '../utils';
import { FFmpegService } from './ffmpeg';
import { CDNService } from './cdn';
import { ConfigService } from './config';
import { VOD_DIR } from '../../constants';

interface VodStreamInfo {
  command: FfmpegCommand;
  recordingId: string;
  streamPath: string;
  format: 'mp4' | 'hls';
  metadataPath: string;
}

export class VodService {
  private vodStreams: Map<string, VodStreamInfo>;
  private config: VodConfig;
  private ffmpeg!: typeof ffmpeg;
  private isStreaming: Map<string, boolean>;
  private cdnService: CDNService;
  private cdnUploads: Map<string, Set<string>>;
  private vodDir: string;
  private isShuttingDown: boolean = false;

  constructor(config: VodConfig) {
    this.config = config;
    this.vodStreams = new Map();
    this.isStreaming = new Map();
    this.cdnUploads = new Map();

    const cdnConfig = ConfigService.getInstance().getConfig().cdn;
    this.cdnService = CDNService.getInstance(cdnConfig);

    this.vodDir = VOD_DIR;
    if (!fs.existsSync(this.vodDir)) {
      fs.mkdirSync(this.vodDir, { recursive: true });
    }

    if (!this.cdnService.isEnabled()) {
      this.setupVodDirectories();
    }

    // Initialize FFmpeg
    this.initFFmpeg();

    // Detect and process unsigned recordings on launch
    this.detectAllUnsignedRecordingsOnLaunch();
  }

  private async initFFmpeg(): Promise<void> {
    this.ffmpeg = await FFmpegService.getInstance().getFFmpeg() as unknown as typeof ffmpeg;
  }

  private async detectAllUnsignedRecordingsOnLaunch(): Promise<void> {
    console.log('[VOD] Starting detection of unsigned recordings on launch');

    try {
      // Ensure temp directory exists
      if (!fs.existsSync(this.vodDir)) {
        console.log(`[VOD] Temp directory does not exist: ${this.vodDir}`);
        return;
      }

      // List all stream directories in temp folder
      const streamDirs = fs.readdirSync(this.vodDir)
        .filter(item => {
          const fullPath = path.join(this.vodDir, item);
          return fs.statSync(fullPath).isDirectory();
        });

      console.log(`[VOD] Stream directories found: ${streamDirs.join(', ')}`);

      // Process each stream directory
      for (const streamName of streamDirs) {
        try {
          console.log(`[VOD] Detecting unsigned recordings for stream: ${streamName}`);
          await this.detectUnsignedRecordings(streamName);
        } catch (streamError) {
          console.error(`[VOD] Error processing stream ${streamName}:`, streamError);
        }
      }

      console.log('[VOD] Completed detection of unsigned recordings on launch');
    } catch (error) {
      console.error('[VOD] Error during launch-time unsigned recordings detection:', error);
    }
  }

  private setupVodDirectories(): void {
    [this.config.recordingsDir, this.config.hlsDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private getBasePath(streamName: string): string {
    return this.cdnService.isEnabled()
      ? path.join(this.vodDir, streamName)
      : path.join(this.config.recordingsDir, streamName);
  }

  private getHLSPath(streamName: string, recordingId: string): string {
    return this.cdnService.isEnabled()
      ? path.join(this.vodDir, streamName, recordingId, 'hls')
      : path.join(this.config.hlsDir, streamName, recordingId);
  }

  private async handleFfmpegError(error: Error, info: VodStreamInfo): Promise<void> {
    if (this.isShuttingDown) {
      console.log(`[VOD] Ignoring ffmpeg error during shutdown for ${info.streamPath}`);
      return;
    }

    console.error(`[VOD] FFmpeg error for ${info.streamPath}:`, error);

    try {
      if (fs.existsSync(info.metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(info.metadataPath, 'utf8'));
        metadata.error = error.message;
        metadata.endTime = new Date().toISOString();
        fs.writeFileSync(info.metadataPath, JSON.stringify(metadata, null, 2));
      }
    } catch (err) {
      console.error(`[VOD] Failed to update metadata after error:`, err);
    }
  }

  private async handleFfmpegEnd(info: VodStreamInfo): Promise<void> {
    if (this.isShuttingDown) {
      console.log(`[VOD] Recording ended during shutdown for ${info.streamPath}`);
    } else {
      console.log(`[VOD] Recording completed normally for ${info.streamPath}`);
    }

    try {
      if (fs.existsSync(info.metadataPath)) {
        const metadata: RecordingMetadata = JSON.parse(fs.readFileSync(info.metadataPath, 'utf8'));
        metadata.endTime = new Date().toISOString();

        if (info.format === 'mp4') {
          const mp4Format = metadata.formats.find(f => f.type === 'mp4');
          if (mp4Format && fs.existsSync(mp4Format.path)) {
            const duration = await this.getVideoDuration(mp4Format.path);
            if (duration) metadata.duration = duration;
          }
        }

        fs.writeFileSync(info.metadataPath, JSON.stringify(metadata, null, 2));

        if (this.cdnService.isEnabled() && !this.isShuttingDown) {
          const streamName = info.streamPath.split('/').pop() || '';
          const format = metadata.formats.find(f => f.type === info.format);
          if (format) {
            await this.handleCDNUpload(info.recordingId, streamName, format);
          }
        }
      }
    } catch (error) {
      console.error(`[VOD] Error handling recording end:`, error);
    }
  }

  async startRecording(streamPath: string, inputUrl: string): Promise<string | null> {
    if (this.isShuttingDown) {
      console.log(`[VOD] Cannot start recording during shutdown`);
      return null;
    }

    const streamName = streamPath.split('/').pop() || '';
    const recordingId = `${streamName}_${new Date().toISOString().replace(/[:.]/g, '-')}`;

    try {
      const basePath = this.getBasePath(streamName);
      const hlsDir = this.getHLSPath(streamName, recordingId);

      fs.mkdirSync(basePath, { recursive: true });
      if (this.config.recordingFormats.hls) {
        fs.mkdirSync(hlsDir, { recursive: true });
      }

      const mp4Path = path.join(basePath, `${recordingId}.mp4`);
      const metadataPath = path.join(basePath, `${recordingId}.json`);

      const metadata = {
        streamPath,
        recordingId,
        startTime: new Date().toISOString(),
        formats: [] as RecordingFormat[]
      };

      const cdnConfig = ConfigService.getInstance().getConfig().cdn;
      const cdnEnabled = this.cdnService.isEnabled();
      const cdnBaseUrl = cdnConfig.url;

      // Enhanced MP4 recording with more robust options
      if (this.config.recordingFormats.mp4) {
        const format: RecordingFormat = {
          type: 'mp4',
          path: mp4Path,
          webPath: cdnEnabled && cdnBaseUrl
            ? `${cdnBaseUrl}${cdnConfig.paths.recordings}/${streamName}/${recordingId}/${path.basename(mp4Path)}`
            : `/recordings/${streamName}/${recordingId}.mp4`
        };
        metadata.formats.push(format);

        const mp4Process = this.ffmpeg(inputUrl)
          .inputOptions([
            ...this.config.mp4Options.input,
            '-fflags', '+genpts',
            '-err_detect', 'ignore_err',
            '-copytb', '1'
          ])
          .outputOptions([
            ...this.config.mp4Options.output,
            '-bsf:v', 'h264_mp4toannexb',
            '-max_muxing_queue_size', '1024',
            '-f', 'mp4',
            '-movflags', '+faststart+write_colr'
          ])
          .on('start', (commandLine) => {
            console.log(`[VOD] MP4 Recording started: ${commandLine}`);
          })
          .output(mp4Path);

        const mp4Info: VodStreamInfo = {
          command: mp4Process,
          recordingId,
          streamPath,
          format: 'mp4',
          metadataPath
        };

        mp4Process
          .on('error', (err, stdout, stderr) => {
            console.error(`[VOD] MP4 Recording error:`, err);
            console.error(`[VOD] FFmpeg stderr:`, stderr);
            this.handleFfmpegError(err, mp4Info);
          })
          .on('end', () => {
            console.log(`[VOD] MP4 Recording completed successfully`);
            this.handleFfmpegEnd(mp4Info);
          });

        mp4Process.run();
        this.vodStreams.set(`${streamPath}-mp4`, mp4Info);
      }

      // Enhanced HLS recording with more robust options
      if (this.config.recordingFormats.hls) {
        const format: RecordingFormat = {
          type: 'hls',
          path: hlsDir,
          webPath: cdnEnabled && cdnBaseUrl
            ? `${cdnBaseUrl}${cdnConfig.paths.hls}/${streamName}/${recordingId}/playlist.m3u8`
            : `/hls/${streamName}/${recordingId}/playlist.m3u8`
        };
        metadata.formats.push(format);

        const hlsProcess = this.ffmpeg(inputUrl)
          .inputOptions([
            ...this.config.hlsOptions.input,
            '-fflags', '+genpts',
            '-err_detect', 'ignore_err',
            '-copytb', '1'
          ])
          .outputOptions([
            ...this.config.hlsOptions.output,
            '-hls_time', String(this.config.segmentLength),
            '-hls_list_size', '0',
            '-hls_flags', 'split_by_time+append_list+delete_segments',
            '-hls_segment_filename', path.join(hlsDir, 'segment_%05d.ts'),
            '-hls_playlist_type', 'vod',
            '-max_muxing_queue_size', '1024'
          ])
          .on('start', (commandLine) => {
            console.log(`[VOD] HLS Recording started: ${commandLine}`);
          })
          .output(path.join(hlsDir, 'playlist.m3u8'));

        const hlsInfo: VodStreamInfo = {
          command: hlsProcess,
          recordingId,
          streamPath,
          format: 'hls',
          metadataPath
        };

        hlsProcess
          .on('error', (err, stdout, stderr) => {
            console.error(`[VOD] HLS Recording error:`, err);
            console.error(`[VOD] FFmpeg stderr:`, stderr);
            this.handleFfmpegError(err, hlsInfo);
          })
          .on('end', () => {
            console.log(`[VOD] HLS Recording completed successfully`);
            this.handleFfmpegEnd(hlsInfo);
          });

        hlsProcess.run();
        this.vodStreams.set(`${streamPath}-hls`, hlsInfo);
      }

      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      this.updateRecordingsIndex(streamName);

      return recordingId;

    } catch (error) {
      console.error(`[VOD] Failed to start recording:`, error);
      return null;
    }
  }

  async stopRecording(streamPath: string): Promise<void> {
    const activeStreams = Array.from(this.vodStreams.entries())
      .filter(([key]) => key.startsWith(`${streamPath}-`));

    const stopPromises = activeStreams.map(async ([key, info]) => {
      try {
        console.log(`[VOD] Stopping recording ${key}`);

        await new Promise<void>((resolve, reject) => {
          // Longer timeout to ensure proper file closure
          const stopTimeout = setTimeout(() => {
            console.warn(`[VOD] Forced stop for recording ${key}`);
            try {
              info.command.kill('SIGKILL');
            } catch (killError) {
              console.error(`Error killing stream ${key}:`, killError);
            }
            resolve();
          }, 30000); // 30-second timeout

          // Normal end handler
          info.command.on('end', () => {
            console.log(`[VOD] Recording ${key} stopped normally`);
            clearTimeout(stopTimeout);
            resolve();
          });

          // Error handler with more detailed logging
          info.command.on('error', (err, stdout, stderr) => {
            console.error(`[VOD] Error stopping recording ${key}:`, err);
            console.error(`[VOD] FFmpeg stdout:`, stdout);
            console.error(`[VOD] FFmpeg stderr:`, stderr);

            clearTimeout(stopTimeout);

            // Check if the error is recoverable
            if (err.message !== 'Output stream closed') {
              this.handleFfmpegError(err, info);
            }

            resolve();
          });

          // Request FFmpeg to stop
          info.command.kill('SIGINT');
        });

        // Handle FFmpeg end and update metadata
        await this.handleFfmpegEnd(info);

        // Remove from active streams
        this.vodStreams.delete(key);
      } catch (error) {
        console.error(`[VOD] Error stopping recording ${key}:`, error);
      }
    });

    // Wait for all stop operations to complete
    await Promise.all(stopPromises);

    // Remove streaming state
    this.isStreaming.delete(streamPath);
  }

  private async getVideoDuration(filePath: string): Promise<number | null> {
    return new Promise((resolve) => {
      // this.ffmpeg.ffprobe(filePath, (err, metadata) => {
      //   resolve(err || !metadata?.format?.duration ? null : metadata.format.duration);
      // });

      // if ffmpeg is not initialized, make a timeout to retry and retry count
      if (typeof this.ffmpeg === 'undefined' || !this.ffmpeg.ffprobe) {
        let retries = 0;
        const interval = setInterval(() => {
          if ('ffprobe' in this.ffmpeg && this.ffmpeg.ffprobe) {
            clearInterval(interval);
            this.ffmpeg.ffprobe(filePath, (err, metadata) => {
              resolve(err || !metadata?.format?.duration ? null : metadata.format.duration);
            });
          } else if (retries >= 10) {
            clearInterval(interval);
            resolve(null);
          } else {
            retries++;
          }
        }, 1000);
      }
    });
  }

  async stopAllRecordings(): Promise<void> {
    // Early return if no active streams
    if (this.vodStreams.size === 0) {
      return;
    }

    const stopPromises = Array.from(this.vodStreams.entries()).map(async ([key, info]) => {
      try {
        console.log(`[VOD] Stopping recording ${key}`);

        // Graceful stop with timeout
        await new Promise<void>((resolve) => {
          const stopTimeout = setTimeout(() => {
            console.warn(`[VOD] Forced stop for recording ${key}`);
            info.command.kill('SIGKILL');
            resolve();
          }, 10000);

          // Normal end handler
          info.command.on('end', () => {
            clearTimeout(stopTimeout);
            resolve();
          });

          // Error handler
          info.command.on('error', (err) => {
            clearTimeout(stopTimeout);
            if (err.message !== 'Output stream closed') {
              console.error(`[VOD] Error stopping recording ${key}:`, err);
            }
            resolve();
          });

          // Request FFmpeg to stop
          info.command.kill('SIGINT');
        });

        // Handle FFmpeg end and update metadata
        await this.handleFfmpegEnd(info);

        // Remove from active streams
        this.vodStreams.delete(key);

        // Remove streaming state
        const streamPath = key.split('-')[0];
        this.isStreaming.delete(streamPath);
      } catch (error) {
        console.error(`[VOD] Error stopping recording ${key}:`, error);
      }
    });

    // Wait for all stop operations to complete
    await Promise.all(stopPromises);
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      console.log('[VOD] Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    console.log('[VOD] Starting shutdown...');

    try {
      // Stop all recordings gracefully
      await this.stopAllRecordings();

      // Handle CDN uploads if enabled
      if (this.cdnService.isEnabled()) {
        const promises = Array.from(this.cdnUploads.entries()).map(async ([recordingId]) => {
          try {
            const status = await this.getCDNUploadStatus(recordingId);
            if (status.completed || status.failed) {
              const streamDir = Array.from(this.vodStreams.values())
                .find(info => info.recordingId === recordingId)
                ?.streamPath.split('/').pop();

              if (streamDir) {
                this.cleanupTempFiles(recordingId, streamDir);
              }
            }
          } catch (uploadError) {
            console.error(`[VOD] CDN upload cleanup error for ${recordingId}:`, uploadError);
          }
        });

        await Promise.allSettled(promises);
      }

      // Destroy CDN service
      this.cdnService.destroy();
    } catch (error) {
      console.error('[VOD] Shutdown error:', error);
    } finally {
      this.isShuttingDown = false;
      console.log('[VOD] Shutdown complete');
    }
  }

  async cleanupOldRecordings(): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.retention.days);

      const basePath = this.cdnService.isEnabled() ? this.vodDir : this.config.recordingsDir;
      const streamDirs = fs.readdirSync(basePath);

      for (const streamDir of streamDirs) {
        const dirPath = path.join(basePath, streamDir);
        if (!fs.statSync(dirPath).isDirectory()) continue;

        const files = fs.readdirSync(dirPath);
        const metadataFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json');

        for (const file of metadataFiles) {
          try {
            const metadataPath = path.join(dirPath, file);
            const metadata: RecordingMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

            if (new Date(metadata.startTime) < cutoffDate) {
              const status = await this.getCDNUploadStatus(metadata.recordingId);
              if (!this.cdnService.isEnabled() || !status.inProgress) {
                metadata.formats.forEach(format => {
                  if (fs.existsSync(format.path)) {
                    format.type === 'hls'
                      ? fs.rmSync(format.path, { recursive: true, force: true })
                      : fs.unlinkSync(format.path);
                  }
                });
                fs.unlinkSync(metadataPath);
                this.cdnUploads.delete(metadata.recordingId);
              }
            }
          } catch (error) {
            console.error(`[VOD] Error cleaning up recording:`, error);
          }
        }
        this.updateRecordingsIndex(streamDir);
      }
    } catch (error) {
      console.error('[VOD] Error during cleanup:', error);
    }
  }

  async getCDNUploadStatus(recordingId: string): Promise<{
    inProgress: boolean;
    completed: boolean;
    failed: boolean;
    uploadIds: string[];
  }> {
    const uploadIds = Array.from(this.cdnUploads.get(recordingId) || []);
    const statuses = uploadIds.map(id => this.cdnService.getUploadStatus(id));

    return {
      inProgress: statuses.some(s => s?.status === 'uploading' || s?.status === 'pending'),
      completed: statuses.every(s => s?.status === 'completed'),
      failed: statuses.some(s => s?.status === 'failed'),
      uploadIds
    };
  }

  updateRecordingsIndex(streamName: string): void {
    try {
      const streamDir = this.getBasePath(streamName);
      if (!fs.existsSync(streamDir)) return;

      const files = fs.readdirSync(streamDir);
      const metadataFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json');
      const recordings = metadataFiles
        .map(file => {
          try {
            return JSON.parse(fs.readFileSync(path.join(streamDir, file), 'utf8'));
          } catch (err) {
            return null;
          }
        })
        .filter((m): m is RecordingMetadata => m !== null);

      const indexPath = path.join(streamDir, 'index.json');
      fs.writeFileSync(indexPath, JSON.stringify({
        streamName,
        lastUpdated: new Date().toISOString(),
        recordings: sanitizeRecordingsIndex(recordings)
      }, null, 2));
    } catch (error) {
      console.error(`[VOD] Error updating index:`, error);
    }
  }

  async getRecordingInfo(streamName: string, recordingId: string): Promise<RecordingMetadata | null> {
    try {
      const metadataPath = path.join(this.getBasePath(streamName), `${recordingId}.json`);
      if (!fs.existsSync(metadataPath)) return null;
      return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch (error) {
      console.error(`[VOD] Error getting recording info:`, error);
      return null;
    }
  }

  getActiveRecordings(): Array<{ streamName: string; formats: Array<'mp4' | 'hls'> }> {
    const streamMap = new Map<string, Set<'mp4' | 'hls'>>();
    this.vodStreams.forEach((info) => {
      const streamName = info.streamPath.split('/').pop() || '';
      if (!streamMap.has(streamName)) {
        streamMap.set(streamName, new Set());
      }
      streamMap.get(streamName)?.add(info.format);
    });

    return Array.from(streamMap.entries()).map(([streamName, formats]) => ({
      streamName,
      formats: Array.from(formats)
    }));
  }

  markStreamingStarted(streamPath: string): void {
    this.isStreaming.set(streamPath, true);
  }

  markStreamingEnded(streamPath: string): void {
    this.isStreaming.delete(streamPath);
    const streamName = streamPath.split('/').pop();
    if (streamName) {
      this.detectUnsignedRecordings(streamName);
    }
  }

  isStreamActive(streamName: string): boolean {
    return this.isStreaming.get(streamName) || false;
  }

  async detectUnsignedRecordings(streamName: string): Promise<void> {
    console.log(`[VOD] Starting unsigned recordings detection for: ${streamName}`);

    try {
      // Always use temp directory for detection
      const streamDir = path.join(this.vodDir, streamName);

      // Ensure stream directory exists
      if (!fs.existsSync(streamDir)) {
        console.log(`[VOD] Stream directory does not exist: ${streamDir}`);
        return;
      }

      // List all files in the directory
      const files = fs.readdirSync(streamDir);

      // Find all MP4 files and existing metadata files
      const mp4Files = files.filter(f => f.endsWith('.mp4'));
      const metadataFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json');

      console.log(`[VOD] MP4 Files found: ${mp4Files.join(', ')}`);
      console.log(`[VOD] Metadata Files found: ${metadataFiles.join(', ')}`);

      // Create a set of already signed MP4 files
      const signedMp4s = new Set(
        metadataFiles.flatMap(file => {
          try {
            const metadata: RecordingMetadata = JSON.parse(
              fs.readFileSync(path.join(streamDir, file), 'utf8')
            );
            return metadata.formats
              .filter(f => f.type === 'mp4')
              .map(f => path.basename(f.path));
          } catch (err) {
            console.error(`[VOD] Error reading metadata file ${file}:`, err);
            return [];
          }
        })
      );

      console.log(`[VOD] Already signed MP4s: ${Array.from(signedMp4s).join(', ')}`);

      // Process unsigned MP4 files
      for (const mp4File of mp4Files.filter(mp4 => !signedMp4s.has(mp4))) {
        try {
          const mp4Path = path.join(streamDir, mp4File);
          const stats = fs.statSync(mp4Path);
          const recordingId = mp4File.replace('.mp4', '');

          console.log(`[VOD] Processing unsigned recording: ${mp4File}`);

          // Create metadata for unsigned recording
          const metadata: RecordingMetadata = {
            streamPath: `/live/${streamName}`,
            recordingId,
            startTime: stats.birthtime.toISOString(),
            endTime: stats.mtime.toISOString(),
            formats: [{
              type: 'mp4' as const,
              path: mp4Path,
              webPath: this.cdnService.isEnabled()
                ? `${ConfigService.getInstance().getConfig().cdn.url}${ConfigService.getInstance().getConfig().cdn.paths.recordings}/${streamName}/${recordingId}.mp4`
                : `/recordings/${streamName}/${mp4File}`
            }]
          };

          // Get video duration
          const duration = await this.getVideoDuration(mp4Path);
          if (duration) {
            metadata.duration = duration;
            console.log(`[VOD] Duration for ${mp4File}: ${duration} seconds`);
          }

          // Write metadata file
          const metadataPath = path.join(streamDir, `${recordingId}.json`);
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          console.log(`[VOD] Created metadata for unsigned recording: ${metadataPath}`);

          // Handle CDN upload if enabled
          if (this.cdnService.isEnabled()) {
            const uploadId = await this.handleCDNUpload(recordingId, streamName, metadata.formats[0]);

            // If upload is successful, check its status and cleanup if needed
            if (uploadId) {
              const uploadStatus = await this.getCDNUploadStatus(recordingId);
              if (uploadStatus.completed) {
                console.log(`[VOD] CDN upload completed for ${recordingId}, cleaning up temp files`);
                this.cleanupTempFiles(recordingId, streamName);
              }
            }
          }
        } catch (error) {
          console.error(`[VOD] Error processing unsigned recording ${mp4File}:`, error);
        }
      }

      // Always update recordings index
      this.updateRecordingsIndex(streamName);
      console.log(`[VOD] Completed unsigned recording detection for ${streamName}`);

    } catch (error) {
      console.error(`[VOD] Error detecting unsigned recordings:`, error);
    }
  }

  private async handleCDNUpload(recordingId: string, streamName: string, format: RecordingFormat): Promise<string | null> {
    if (!this.cdnService.isEnabled() || this.isShuttingDown) return null;

    try {
      const remotePath = `/${streamName}/${recordingId}`;
      let uploadId: string | null = null;

      if (format.type === 'mp4' && fs.existsSync(format.path)) {
        uploadId = await this.cdnService.uploadRecording(format.path, remotePath, path.basename(format.path));

        // If upload is successful, add to uploads tracking
        if (uploadId) {
          this.cdnUploads.set(recordingId, (this.cdnUploads.get(recordingId) || new Set()).add(uploadId));
        }
      } else if (format.type === 'hls' && fs.existsSync(format.path)) {
        const files = fs.readdirSync(format.path);
        for (const file of files) {
          const filePath = path.join(format.path, file);
          if (fs.existsSync(filePath)) {
            uploadId = await this.cdnService.uploadHLS(filePath, remotePath, file);
            if (uploadId) {
              this.cdnUploads.set(recordingId, (this.cdnUploads.get(recordingId) || new Set()).add(uploadId));
            }
          }
        }
      }

      return uploadId;
    } catch (error) {
      console.error(`[VOD] CDN upload failed:`, error);
      return null;
    }
  }

  private cleanupTempFiles(recordingId: string, streamName: string): void {
    if (!this.cdnService.isEnabled()) return;

    try {
      const basePath = path.join(this.vodDir, streamName);
      const recordingPath = path.join(basePath, recordingId);
      const hlsDir = path.join(recordingPath, 'hls');
      const mp4Path = path.join(basePath, `${recordingId}.mp4`);
      const metadataPath = path.join(basePath, `${recordingId}.json`);

      // Remove HLS directory if it exists
      if (fs.existsSync(hlsDir)) {
        fs.rmSync(hlsDir, { recursive: true, force: true });
      }

      // Remove individual HLS recording directory if it exists
      if (fs.existsSync(recordingPath)) {
        fs.rmSync(recordingPath, { recursive: true, force: true });
      }

      // Remove MP4 file
      if (fs.existsSync(mp4Path)) {
        fs.unlinkSync(mp4Path);
      }

      // Remove metadata file
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
      }

      // Try to remove the stream directory if it's empty
      if (fs.existsSync(basePath) && fs.readdirSync(basePath).length === 0) {
        fs.rmdirSync(basePath);
      }

      console.log(`[VOD] Cleaned up temp files for recording: ${recordingId}`);
    } catch (error) {
      console.error(`[VOD] Error cleaning up temp files:`, error);
    }
  }
}