import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import os from 'os';
import { createWriteStream } from 'fs';
import { chmod } from 'fs/promises';
import { extract } from 'tar';
import { createGunzip } from 'zlib';
import { Stream } from 'stream';
import { promisify } from 'util';
import yauzl from 'yauzl';
import { pipeline } from 'stream/promises';

const FFMPEG_RELEASE_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';

interface PlatformConfig {
  platform: string;
  arch: string;
  url: string;
  archiveName: string;
  binaries: {
    ffmpeg: string;
    ffprobe: string;
  };
  paths: {
    ffmpeg: string;
    ffprobe: string;
  };
}

export class FFmpegService {
  private static instance: FFmpegService;
  private initPromise: Promise<void> | null = null;
  private initialized: boolean = false;
  private readonly libPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly config: PlatformConfig;

  private constructor() {
    this.platform = os.platform();
    this.arch = os.arch();
    this.libPath = path.join(process.cwd(), 'lib', 'ffmpeg');
    this.config = this.getPlatformConfig();
  }

  static getInstance(): FFmpegService {
    if (!FFmpegService.instance) {
      FFmpegService.instance = new FFmpegService();
    }
    return FFmpegService.instance;
  }

  private getPlatformConfig(): PlatformConfig {
    const platform = this.platform;
    const arch = this.arch;

    // Check platform and architecture compatibility
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(`Unsupported architecture: ${arch}`);
    }

    const baseConfigs: Record<string, PlatformConfig> = {
      win32: {
        platform: 'win32',
        arch: 'x64',
        url: `${FFMPEG_RELEASE_BASE}/ffmpeg-n6.1-latest-win64-gpl-6.1.zip`,
        archiveName: 'ffmpeg-n6.1-latest-win64-gpl-6.1',
        binaries: {
          ffmpeg: 'ffmpeg.exe',
          ffprobe: 'ffprobe.exe'
        },
        paths: {
          ffmpeg: 'bin/ffmpeg.exe',
          ffprobe: 'bin/ffprobe.exe'
        }
      },
      linux: {
        platform: 'linux',
        arch: 'x64',
        url: `${FFMPEG_RELEASE_BASE}/ffmpeg-n6.1-latest-linux64-gpl-6.1.tar.xz`,
        archiveName: 'ffmpeg-n6.1-latest-linux64-gpl-6.1',
        binaries: {
          ffmpeg: 'ffmpeg',
          ffprobe: 'ffprobe'
        },
        paths: {
          ffmpeg: 'bin/ffmpeg',
          ffprobe: 'bin/ffprobe'
        }
      }
    };

    const config = baseConfigs[platform];
    if (!config) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    return config;
  }

  private getBinaryPaths(): { ffmpeg: string; ffprobe: string } {
    return {
      ffmpeg: path.join(this.libPath, this.config.binaries.ffmpeg),
      ffprobe: path.join(this.libPath, this.config.binaries.ffprobe)
    };
  }

  private async initialize(): Promise<void> {
    // If already initialized, return immediately
    if (this.initialized) return;

    // If initialization is in progress, wait for it
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    // Start new initialization
    this.initPromise = (async () => {
      try {
        // First try to use system FFmpeg
        this.checkSystemFFmpeg();
      } catch (error) {
        console.log('[FFmpeg] System FFmpeg not found, downloading bundled version...');
        await this.downloadFFmpeg();
      } finally {
        this.initialized = true;
        this.initPromise = null;
      }
    })();

    await this.initPromise;
  }

  private checkSystemFFmpeg(): void {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      execSync('ffprobe -version', { stdio: 'ignore' });
      console.log('[FFmpeg] Using system FFmpeg installation');
    } catch (error) {
      throw new Error('System FFmpeg/FFprobe not found');
    }
  }

  private async extractZip(zipPath: string): Promise<void> {
    const binaryPaths = this.getBinaryPaths();
    const expectedFiles = new Set([
      `${this.config.archiveName}/${this.config.paths.ffmpeg}`,
      `${this.config.archiveName}/${this.config.paths.ffprobe}`
    ]);
    
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        if (!zipfile) return reject(new Error('Failed to open zip file'));

        const extractedFiles = new Set<string>();
        zipfile.readEntry();

        zipfile.on('entry', (entry) => {
          if (expectedFiles.has(entry.fileName)) {
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) return reject(err);
              if (!readStream) return reject(new Error('Failed to open read stream'));

              const isFfmpeg = entry.fileName.endsWith(this.config.paths.ffmpeg);
              const targetPath = isFfmpeg ? binaryPaths.ffmpeg : binaryPaths.ffprobe;

              const writeStream = createWriteStream(targetPath);
              readStream.pipe(writeStream);

              writeStream.on('finish', () => {
                extractedFiles.add(entry.fileName);
                if (extractedFiles.size === expectedFiles.size) {
                  zipfile.close();
                  resolve();
                } else {
                  zipfile.readEntry();
                }
              });

              writeStream.on('error', (err) => {
                zipfile.close();
                reject(err);
              });
            });
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on('error', (err) => reject(err));
      });
    });
  }

  private async extractTarXz(tarPath: string): Promise<void> {
    const binaryPaths = this.getBinaryPaths();
    const lzma = await import('lzma-native');

    // Create a temporary .tar file path
    const tarFilePath = tarPath.replace('.tar.xz', '.tar');

    try {
      // Read the .tar.xz file
      const xzData = await fs.promises.readFile(tarPath);
      
      // Decompress the .tar.xz to .tar
      const tarData = await new Promise<Buffer>((resolve, reject) => {
        lzma.decompress(xzData, {}, (result: Buffer | Error) => {
          if (result instanceof Error) {
            reject(result);
          } else {
            resolve(result);
          }
        });
      });
      await fs.promises.writeFile(tarFilePath, tarData);

      // Now extract the .tar file
      await extract({
        file: tarFilePath,
        cwd: this.libPath,
        filter: (path) => {
          const relativePath = path.split('/').slice(1).join('/');
          return relativePath === this.config.paths.ffmpeg || 
                 relativePath === this.config.paths.ffprobe;
        }
      });

      // Move the binaries to their final location
      const moveFile = (sourcePath: string, targetPath: string) => {
        if (fs.existsSync(sourcePath)) {
          fs.renameSync(sourcePath, targetPath);
        }
      };

      moveFile(
        path.join(this.libPath, this.config.archiveName, this.config.paths.ffmpeg),
        binaryPaths.ffmpeg
      );

      moveFile(
        path.join(this.libPath, this.config.archiveName, this.config.paths.ffprobe),
        binaryPaths.ffprobe
      );

      // Cleanup the extracted directory
      const extractedDir = path.join(this.libPath, this.config.archiveName);
      if (fs.existsSync(extractedDir)) {
        fs.rmSync(extractedDir, { recursive: true, force: true });
      }
    } finally {
      // Cleanup temporary tar file
      if (fs.existsSync(tarFilePath)) {
        fs.unlinkSync(tarFilePath);
      }
    }
  }

  private async downloadFFmpeg(): Promise<void> {
    const binaryPaths = this.getBinaryPaths();
    const tempPath = path.join(this.libPath, `download-${Date.now()}`);

    // Create lib directory if it doesn't exist
    fs.mkdirSync(this.libPath, { recursive: true });

    // Check if binaries already exist
    if (fs.existsSync(binaryPaths.ffmpeg) && fs.existsSync(binaryPaths.ffprobe)) {
      console.log('[FFmpeg] FFmpeg binaries already exist, skipping download');
      ffmpeg.setFfmpegPath(binaryPaths.ffmpeg);
      ffmpeg.setFfprobePath(binaryPaths.ffprobe);
      return;
    }

    console.log(`[FFmpeg] Downloading FFmpeg from ${this.config.url}`);
    
    try {
      const response = await axios({
        method: 'GET',
        url: this.config.url,
        responseType: 'stream',
        maxRedirects: 5
      });

      const writeStream = createWriteStream(tempPath);
      await pipeline(response.data, writeStream);

      // Extract based on file type
      if (this.config.url.endsWith('.zip')) {
        await this.extractZip(tempPath);
      } else if (this.config.url.endsWith('.tar.xz')) {
        await this.extractTarXz(tempPath);
      }

      // Make binaries executable on Unix systems
      if (this.platform !== 'win32') {
        await chmod(binaryPaths.ffmpeg, '755');
        await chmod(binaryPaths.ffprobe, '755');
      }

      // Set FFmpeg paths
      ffmpeg.setFfmpegPath(binaryPaths.ffmpeg);
      ffmpeg.setFfprobePath(binaryPaths.ffprobe);
      
      console.log('[FFmpeg] Successfully downloaded and configured FFmpeg');
    } catch (error) {
      console.error('[FFmpeg] Error downloading FFmpeg:', error);
      throw error;
    } finally {
      // Cleanup temp file
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }

  async getFFmpeg(): Promise<typeof ffmpeg> {
    await this.initialize();
    return ffmpeg;
  }

  getFFmpegSync(): typeof ffmpeg {
    if (!this.initialized) {
      throw new Error('FFmpeg is not initialized. Call getFFmpeg() first to ensure initialization.');
    }
    return ffmpeg;
  }
}