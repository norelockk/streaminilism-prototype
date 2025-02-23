import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { CDNConfig } from '../types';

interface UploadTask {
  id: string;
  localPath: string;
  remotePath: string;
  fileName: string;
  fileSize: number;
  retryCount: number;
  format: 'mp4' | 'hls';
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  error?: Error;
}

interface UploadProgress {
  uploadId: string;
  fileName: string;
  progress: number;
  speed: number;
  remainingTime: number;
}

export class CDNUploadService extends EventEmitter {
  private uploadQueue: UploadTask[] = [];
  private activeUploads = new Set<string>();
  private uploadStats: Map<string, {
    startTime: number;
    bytesUploaded: number;
    lastCheckpoint: number;
  }> = new Map();
  private config: Required<CDNConfig>;
  private isShuttingDown: boolean = false;
  private goProcess: ChildProcessWithoutNullStreams | null = null;
  private wsClient: WebSocket | null = null;
  private wsPort: number;
  private initPromise: Promise<void>;
  private static BINARY_NAME = os.platform() === 'win32' ? 'bunny-upload.exe' : 'bunny-upload';
  private binaryPath: string;

  constructor(config: CDNConfig) {
    super();

    if (!config.credentials?.storageZone || !config.credentials?.storageKey) {
      throw new Error('Storage zone and storage key are required');
    }

    this.config = {
      ...config,
      options: {
        maxConcurrentUploads: config.options?.maxConcurrentUploads || 3,
        retryAttempts: config.options?.retryAttempts || 3,
        retryDelay: config.options?.retryDelay || 5000
      }
    };

    this.wsPort = Math.floor(Math.random() * 10000) + 10000;
    this.binaryPath = path.join(process.cwd(), 'src', 'go', CDNUploadService.BINARY_NAME);
    this.initPromise = this.initialize().catch(err => {
      console.log('[CDN Upload Service] Initialization failed:', err);
      throw err;
    });
  }

  private async initialize(): Promise<void> {
    try {
      await this.startGoProcess();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.connectWebSocket();
    } catch (error) {
      console.log('[CDN Upload Service] Failed to initialize:', error);
      throw error;
    }
  }

  private async startGoProcess(): Promise<void> {
    if (this.isShuttingDown) return;

    return new Promise((resolve, reject) => {
      try {
        const args = [
          '--zone', this.config.credentials.storageZone,
          '--write-key', this.config.credentials.storageKey,
          '--endpoint', 'falkenstein',
          '--ws-port', this.wsPort.toString(),
          '--max-concurrent', this.config.options.maxConcurrentUploads.toString(),
          '--retry-attempts', this.config.options.retryAttempts.toString(),
          '--retry-delay', this.config.options.retryDelay.toString(),
          '--verbose'
        ];

        console.log('[CDN Upload Service] Starting binary with args:', args.join(' '));

        this.goProcess = spawn(this.binaryPath, args, {
          cwd: path.join(process.cwd(), 'src', 'go')
        });

        let errorOutput = '';
        let started = false;
        let resolveTimer: NodeJS.Timeout;

        // Changed to listen on stdout instead of stderr
        const startupHandler = (data: Buffer) => {
          const message = data.toString().trim();
          console.log(`[CDN Upload Service] STDOUT: ${message}`);

          if (message.includes('WebSocket server listening')) {
            started = true;

            resolveTimer = setTimeout(() => {
              console.log('[CDN Upload Service] Binary started successfully');
              resolve();
            }, 500);
          }
        };

        this.goProcess.stdout.on('data', startupHandler);

        // Keep stderr handler for actual errors
        this.goProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
          console.log(`[CDN Upload Service] Error Output: ${data.toString().trim()}`);
        });

        this.goProcess.on('error', (error) => {
          reject(new Error(`Failed to start binary: ${error.message}\n${errorOutput}`));
        });

        this.goProcess.on('exit', (code) => {
          if (resolveTimer) clearTimeout(resolveTimer);
          if (code !== 0 && !started) {
            reject(new Error(`Binary exited with code ${code}:\n${errorOutput}`));
          }
        });

        const timeout = setTimeout(() => {
          if (!started) {
            this.goProcess?.stdout.removeListener('data', startupHandler);
            this.goProcess?.kill();
            reject(new Error('Binary startup timed out'));
          }
        }, 10000);

        this.goProcess.stdout.on('data', () => {
          if (started) {
            clearTimeout(timeout);
          }
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  private async executeGoCommand(command: string, args: string[]): Promise<void> {
    await this.ensureInitialized();

    const fullArgs = [
      command,
      '--zone', this.config.credentials.storageZone,
      '--write-key', this.config.credentials.storageKey,
      '--endpoint', 'falkenstein',
      '--verbose',
      ...args
    ];

    return new Promise((resolve, reject) => {
      const goProcess = spawn(this.binaryPath, fullArgs, {
        cwd: path.join(process.cwd(), 'src', 'go')
      });

      let errorOutput = '';

      goProcess.stdout.on('data', (data) => {
        console.log(`[CDN Upload Service] ${data.toString().trim()}`);
      });

      goProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
        console.log(`[CDN Upload Service Error] ${data.toString().trim()}`);
      });

      goProcess.on('error', (error) => {
        reject(new Error(`Command failed: ${error.message}\n${errorOutput}`));
      });

      goProcess.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with code ${code}:\n${errorOutput}`));
        }
      });
    });
  }

  private async connectWebSocket(): Promise<void> {
    if (this.isShuttingDown) return;

    return new Promise((resolve, reject) => {
      try {
        this.wsClient = new WebSocket(`ws://localhost:${this.wsPort}/ws`);

        this.wsClient.onopen = () => {
          console.log('[CDN Upload Service] WebSocket connected');
          resolve();
        };

        this.wsClient.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data.toString());
            this.handleWebSocketMessage(message);
          } catch (error) {
            console.log('[CDN Upload Service] Error handling message:', error);
          }
        };

        this.wsClient.onclose = () => {
          if (!this.isShuttingDown) {
            console.log('[CDN Upload Service] WebSocket disconnected, reconnecting...');
            setTimeout(() => this.connectWebSocket(), 5000);
          }
        };

        this.wsClient.onerror = (error) => {
          console.log('[CDN Upload Service] WebSocket error:', error);
          reject(error);
        };

        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timed out'));
        }, 10000);

        this.wsClient.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  private handleWebSocketMessage(message: any): void {
    const task = this.uploadQueue.find(t => t.localPath === message.file);
    if (!task) return;

    switch (message.type) {
      case 'upload_start':
        task.status = 'uploading';
        this.emit('uploadStarted', {
          uploadId: task.id,
          fileName: task.fileName
        });
        break;

      case 'upload_progress':
        const now = Date.now();
        const stats = this.uploadStats.get(task.id);
        if (stats && now - stats.lastCheckpoint > 1000) {
          const progress: UploadProgress = {
            uploadId: task.id,
            fileName: task.fileName,
            progress: message.progress,
            speed: message.speed,
            remainingTime: message.speed > 0 ? (task.fileSize - stats.bytesUploaded) / (message.speed * 1024 * 1024) : 0
          };
          this.emit('uploadProgress', progress);
          stats.lastCheckpoint = now;
          stats.bytesUploaded = Math.floor((message.progress / 100) * task.fileSize);
        }
        break;

      case 'upload_complete':
        task.status = 'completed';
        this.activeUploads.delete(task.id);
        this.emit('uploadCompleted', {
          uploadId: task.id,
          fileName: task.fileName
        });
        break;

      case 'upload_error':
        if (task.retryCount < this.config.options.retryAttempts) {
          task.retryCount++;
          task.status = 'pending';
          this.emit('uploadRetrying', {
            uploadId: task.id,
            fileName: task.fileName,
            attempt: task.retryCount
          });
          this.sendUploadRequest(task);
        } else {
          task.status = 'failed';
          task.error = new Error(message.message);
          this.activeUploads.delete(task.id);
          this.emit('uploadFailed', {
            uploadId: task.id,
            fileName: task.fileName,
            error: task.error
          });
        }
        break;
    }
  }

  private sendUploadRequest(task: UploadTask): void {
    if (this.wsClient?.readyState === WebSocket.OPEN) {
      this.wsClient.send(JSON.stringify({
        type: 'upload',
        file: task.localPath,
        remotePath: path.join(task.remotePath, task.fileName)
      }));
    }
  }

  private async ensureInitialized(): Promise<void> {
    await this.initPromise;
    if (!this.goProcess || !this.wsClient) {
      throw new Error('CDN Upload Service not properly initialized');
    }
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.ensureInitialized();
    const stats = await fs.promises.stat(localPath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${localPath}`);
    }

    await this.executeGoCommand('upload', [localPath, remotePath]);
  }

  async uploadDirectory(localDir: string, remoteDir: string): Promise<void> {
    await this.ensureInitialized();
    const files = await this.listFiles(localDir);
    await this.executeBatch(files, async (file) => {
      const relativePath = path.relative(localDir, file);
      const targetPath = path.join(remoteDir, relativePath);
      await this.uploadFile(file, targetPath);
    });
  }

  async removeFile(remotePath: string): Promise<void> {
    await this.ensureInitialized();
    await this.executeGoCommand('remove', [remotePath]);
  }

  async batchRemove(fileList: string[]): Promise<void> {
    await this.ensureInitialized();
    const tempFile = path.join(os.tmpdir(), `bunny-remove-${Date.now()}.txt`);
    await fs.promises.writeFile(tempFile, fileList.join('\n'));

    try {
      await this.executeGoCommand('batch-remove', [tempFile]);
    } finally {
      try {
        await fs.promises.unlink(tempFile);
      } catch (error) {
        console.log('[CDN Upload Service] Failed to cleanup temp file:', error);
      }
    }
  }

  private async executeBatch<T>(
    items: T[],
    operation: (item: T) => Promise<void>,
    concurrency: number = this.config.options.maxConcurrentUploads
  ): Promise<void> {
    const queue = items.slice();
    const running = new Set<Promise<void>>();

    while (queue.length > 0 || running.size > 0) {
      while (running.size < concurrency && queue.length > 0) {
        const item = queue.shift()!;
        const task = operation(item).finally(() => running.delete(task));
        running.add(task);
      }

      if (running.size >= concurrency || queue.length === 0) {
        await Promise.race(running);
      }
    }
  }

  private async listFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(currentDir: string) {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    }

    await walk(dir);
    return files;
  }

  async queueUpload(
    localPath: string,
    remotePath: string,
    fileName: string,
    format: 'mp4' | 'hls' = 'mp4'
  ): Promise<string> {
    await this.ensureInitialized();

    const stats = await fs.promises.stat(localPath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`Invalid file: ${localPath}`);
    }

    const uploadId = `up_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    const task: UploadTask = {
      id: uploadId,
      localPath,
      remotePath,
      fileName,
      fileSize: stats.size,
      retryCount: 0,
      format,
      status: 'pending'
    };

    this.uploadQueue.push(task);
    this.activeUploads.add(task.id);
    this.uploadStats.set(task.id, {
      startTime: Date.now(),
      bytesUploaded: 0,
      lastCheckpoint: Date.now()
    });

    this.emit('taskQueued', { uploadId, fileName });
    this.sendUploadRequest(task);

    return uploadId;
  }

  getUploadStatus(uploadId: string): {
    id: string;
    status: string;
    progress?: number;
    error?: Error;
    retryCount?: number;
  } | undefined {
    const task = this.uploadQueue.find(t => t.id === uploadId);
    if (!task) return undefined;

    const stats = this.uploadStats.get(uploadId);
    return {
      id: task.id,
      status: task.status,
      progress: stats ? Math.floor((stats.bytesUploaded / task.fileSize) * 100) : undefined,
      error: task.error,
      retryCount: task.retryCount
    };
  }

  getQueuedUploads(): Array<{
    id: string;
    fileName: string;
    status: string;
    progress?: number;
  }> {
    return this.uploadQueue.map(task => {
      const stats = this.uploadStats.get(task.id);
      return {
        id: task.id,
        fileName: task.fileName,
        status: task.status,
        progress: stats ? Math.floor((stats.bytesUploaded / task.fileSize) * 100) : undefined
      };
    });
  }

  getActiveUploads(): Array<{
    id: string;
    fileName: string;
    progress: number;
    speed: number;
  }> {
    return Array.from(this.activeUploads).map(uploadId => {
      const task = this.uploadQueue.find(t => t.id === uploadId);
      const stats = this.uploadStats.get(uploadId);

      if (!task || !stats) return null;

      const elapsed = (Date.now() - stats.startTime) / 1000;
      const speed = stats.bytesUploaded / elapsed;

      return {
        id: uploadId,
        fileName: task.fileName,
        progress: Math.floor((stats.bytesUploaded / task.fileSize) * 100),
        speed
      };
    }).filter((upload): upload is NonNullable<typeof upload> => upload !== null);
  }

  clearFailedUploads(): void {
    this.uploadQueue = this.uploadQueue.filter(task => task.status !== 'failed');
  }

  async retryFailedUpload(uploadId: string): Promise<boolean> {
    await this.ensureInitialized();

    const task = this.uploadQueue.find(t => t.id === uploadId && t.status === 'failed');
    if (!task) return false;

    try {
      await fs.promises.access(task.localPath);
      task.status = 'pending';
      task.retryCount = 0;
      task.error = undefined;

      this.emit('uploadRetrying', {
        uploadId: task.id,
        fileName: task.fileName,
        attempt: 1
      });

      this.sendUploadRequest(task);
      return true;
    } catch (error) {
      console.log(`File no longer exists: ${task.localPath}`);
      return false;
    }
  }

  async cancelUpload(uploadId: string): Promise<boolean> {
    await this.ensureInitialized();

    const task = this.uploadQueue.find(t => t.id === uploadId);
    if (!task) return false;

    if (task.status === 'uploading') {
      if (this.wsClient?.readyState === WebSocket.OPEN) {
        this.wsClient.send(JSON.stringify({
          type: 'cancel',
          file: task.localPath
        }));
      }
      this.activeUploads.delete(task.id);
    }

    this.uploadQueue = this.uploadQueue.filter(t => t.id !== uploadId);
    this.uploadStats.delete(uploadId);

    this.emit('uploadCancelled', {
      uploadId: task.id,
      fileName: task.fileName
    });

    return true;
  }

  async destroy(): Promise<void> {
    this.isShuttingDown = true;

    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }

    if (this.goProcess) {
      return new Promise((resolve) => {
        this.goProcess?.on('exit', () => {
          this.goProcess = null;
          this.uploadQueue = [];
          this.activeUploads.clear();
          this.uploadStats.clear();
          this.removeAllListeners();
          resolve();
        });
        this.goProcess?.kill();
      });
    }
  }
}