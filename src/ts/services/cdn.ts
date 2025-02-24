import { CDNConfig } from '../types';
import { humanReadable, Logger, LogLevel } from '../utils';
import { CDNUploadService } from './cdn-upload';

export class CDNService {
  private static instance: CDNService;
  private uploadService: CDNUploadService | null = null;
  private config: CDNConfig;

  private constructor(config: CDNConfig) {
    this.config = config;
    if (this.config.enabled) {
      this.initializeUploadService();
    }
  }

  static getInstance(config: CDNConfig): CDNService {
    if (!CDNService.instance) {
      CDNService.instance = new CDNService(config);
    }
    return CDNService.instance;
  }

  private initializeUploadService(): void {
    if (!this.config.enabled) return;

    Logger.log(LogLevel.INFO, 'Initializing upload service...');

    try {
      this.uploadService = new CDNUploadService(this.config);

      // Log upload events
      this.uploadService.on('taskQueued', ({ uploadId, fileName }) => {
        Logger.log(LogLevel.INFO, `Upload queued: ${fileName} (${uploadId})`);
      });

      this.uploadService.on('uploadStarted', ({ uploadId, fileName }) => {
        Logger.log(LogLevel.INFO, `Upload started: ${fileName} (${uploadId})`);
      });

      this.uploadService.on('uploadProgress', ({ uploadId, fileName, progress, speed }) => {
        Logger.log(LogLevel.INFO, `Upload progress: ${fileName} (${uploadId}) - ${Math.floor(progress)}% @ ${humanReadable(speed)}`);
      });

      this.uploadService.on('uploadCompleted', ({ uploadId, fileName }) => {
        Logger.log(LogLevel.INFO, `Upload completed: ${fileName} (${uploadId})`);
      });

      this.uploadService.on('uploadFailed', ({ uploadId, fileName, error }) => {
        Logger.log(LogLevel.ERROR, `Upload failed: ${fileName} (${uploadId})`, error);
      });

      this.uploadService.on('uploadRetrying', ({ uploadId, fileName, attempt }) => {
        Logger.log(LogLevel.INFO, `Retrying upload: ${fileName} (${uploadId}), attempt ${attempt}`);
      });

    } catch (error) {
      Logger.log(LogLevel.ERROR, 'Failed to initialize upload service:', error);
      this.uploadService = null;
    }
  }

  async uploadRecording(localPath: string, remotePath: string, fileName: string): Promise<string | null> {
    if (!this.config.enabled || !this.uploadService) {
      return null;
    }

    try {
      const uploadId = await this.uploadService.queueUpload(
        localPath,
        `${this.config.paths.recordings}${remotePath}`,
        fileName
      );
      return uploadId;
    } catch (error) {
      Logger.log(LogLevel.ERROR, 'Failed to queue recording upload:', error);
      return null;
    }
  }

  async uploadHLS(localPath: string, remotePath: string, fileName: string): Promise<string | null> {
    if (!this.config.enabled || !this.uploadService) {
      return null;
    }

    try {
      const uploadId = await this.uploadService.queueUpload(
        localPath,
        `${this.config.paths.hls}${remotePath}`,
        fileName
      );
      return uploadId;
    } catch (error) {
      Logger.log(LogLevel.ERROR, 'Failed to queue HLS upload:', error);
      return null;
    }
  }

  getUploadStatus(uploadId: string | null): any {
    if (!uploadId || !this.config.enabled || !this.uploadService) {
      return null;
    }
    return this.uploadService.getUploadStatus(uploadId);
  }

  updateConfig(newConfig: CDNConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = newConfig;

    if (this.uploadService) {
      this.uploadService.destroy();
      this.uploadService = null;
    }

    if (this.config.enabled) {
      this.initializeUploadService();
    }

    if (wasEnabled !== this.config.enabled) {
      Logger.log(LogLevel.DEBUG, `Service ${this.config.enabled ? 'enabled' : 'disabled'}`);
    }
  }

  isEnabled(): boolean {
    return this.config.enabled && this.uploadService !== null;
  }

  destroy(): void {
    if (this.uploadService) {
      this.uploadService.destroy();
      this.uploadService = null;
    }
  }
}