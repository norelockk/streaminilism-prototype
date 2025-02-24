import fs from 'fs';
import path from 'path';
import express, { Router, Request, Response } from 'express';
import { VodConfig, RecordingMetadata, StreamIndex, MasterIndex } from '../types';
import { ConfigService } from '../services/config';
import { VOD_DIR } from '../../constants';
import { Logger, LogLevel } from '../utils';

export class VodApi {
  private router: Router;
  private config: VodConfig;
  private cdnConfig: any;
  private vodDir: string;
  private basePath: string;

  constructor(config: VodConfig) {
    this.config = config;
    this.cdnConfig = ConfigService.getInstance().getConfig().cdn;
    this.router = express.Router();
    this.vodDir = VOD_DIR;
    this.basePath = this.cdnConfig.enabled ? this.vodDir : this.config.recordingsDir;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.router.get('/recordings', this.listRecordings.bind(this));
    this.router.get('/recordings/:streamName', this.getStreamRecordings.bind(this));
  }

  private createMasterIndex(): MasterIndex {
    try {
      const streams: Array<{
        name: string;
        recordingCount: number;
        lastRecording: string | null;
        indexPath: string;
      }> = [];

      const dirs = fs.readdirSync(this.basePath);

      for (const dir of dirs) {
        const dirPath = path.join(this.basePath, dir);
        if (fs.statSync(dirPath).isDirectory()) {
          const indexPath = path.join(dirPath, 'index.json');
          if (fs.existsSync(indexPath)) {
            try {
              const streamIndex: StreamIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
              streams.push({
                name: dir,
                recordingCount: streamIndex.recordings.length,
                lastRecording: streamIndex.recordings[0]?.startTime || null,
                indexPath: this.cdnConfig.enabled 
                  ? `${this.cdnConfig.url}${this.cdnConfig.paths.recordings}/${dir}`
                  : `/recordings/${dir}`
              });
            } catch (err) {
              Logger.log(LogLevel.ERROR, `Error parsing index for stream ${dir}:`, err);
            }
          }
        }
      }

      streams.sort((a, b) => {
        if (!a.lastRecording) return 1;
        if (!b.lastRecording) return -1;
        return new Date(b.lastRecording).getTime() - new Date(a.lastRecording).getTime();
      });

      return {
        lastUpdated: new Date().toISOString(),
        streams
      };
    } catch (error) {
      Logger.log(LogLevel.ERROR, 'Error creating master index:', error);
      return {
        lastUpdated: new Date().toISOString(),
        streams: []
      };
    }
  }

  private listRecordings(req: Request, res: Response): void {
    try {
      if (!fs.existsSync(this.basePath)) {
        Logger.log(LogLevel.WARN, `Base path does not exist: ${this.basePath}`);
        res.json({ 
          lastUpdated: new Date().toISOString(),
          streams: [] 
        });
        return;
      }

      const masterIndex = this.createMasterIndex();
      if (masterIndex.streams.length > 0) {
        res.json(masterIndex);
      } else {
        res.json({ 
          lastUpdated: new Date().toISOString(),
          streams: [] 
        });
      }
    } catch (error) {
      Logger.log(LogLevel.ERROR, 'Error listing recordings:', error);
      res.status(500).json({ error: 'Failed to retrieve recordings' });
    }
  }

  private getStreamRecordings(req: Request, res: Response): void {
    try {
      const { streamName } = req.params;
      const indexPath = path.join(this.basePath, streamName, 'index.json');

      if (fs.existsSync(indexPath)) {
        const streamIndex: StreamIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        
        // Always transform URLs to hide local paths
        streamIndex.recordings = streamIndex.recordings.map(recording => {
          for (const key in recording.formats) {
            if (recording.formats.hasOwnProperty(key)) {
              delete (recording.formats as Record<string, any>)[key]?.path;
            }
          }

          return recording;
        });

        res.json(streamIndex);
      } else {
        res.status(404).json({ error: 'Stream not found' });
      }
    } catch (error) {
      Logger.log(LogLevel.ERROR, 'Error getting stream recordings:', error);
      res.status(500).json({ error: 'Failed to retrieve stream recordings' });
    }
  }

  getRouter(): Router {
    return this.router;
  }
}