import NodeMediaServer from 'node-media-server';
import express, { Request, Response, NextFunction } from 'express';
import { Server } from 'http';
import { EventEmitter } from 'events';
import { ConfigService } from './services/config';
import { VodService } from './services/vod';
import { StreamService } from './services/stream';
import { VodApi } from './api/vod';

export interface StreamerEvents {
  'stream:ready': (id: string, streamPath: string) => void;
  'stream:started': (id: string, streamPath: string) => void;
  'stream:stopped': (id: string, streamPath: string) => void;
  'stream:error': (id: string, streamPath: string, error: Error) => void;
  'vod:started': (streamPath: string, recordingId: string) => void;
  'vod:stopped': (streamPath: string, recordingId: string) => void;
  'vod:error': (streamPath: string, error: Error) => void;
  'server:started': () => void;
  'server:stopped': () => void;
  'server:error': (error: Error) => void;
}

export class MultiPlatformStreamer extends EventEmitter {
  private nms: NodeMediaServer;
  private vodService: VodService;
  private streamService: StreamService;
  private vodApiApp: Server | null = null;
  private configService: ConfigService;
  private activeStreams: Set<string>;
  private streamSessions: Map<string, string>; // streamPath -> sessionId
  private isShuttingDown: boolean = false;
  private startupTime: Date | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.configService = ConfigService.getInstance();
    const config = this.configService.getConfig();
    this.activeStreams = new Set();
    this.streamSessions = new Map();

    this.nms = new NodeMediaServer(config.server);
    this.vodService = new VodService(config.vod);
    this.streamService = new StreamService();

    this.setupEventHandlers();
    this.setupHealthCheck();

    if (config.vod.retention.days > 0) {
      setInterval(
        () => this.vodService.cleanupOldRecordings(),
        config.vod.retention.cleanupInterval * 1000
      );
    }

    // Watch for config changes
    this.configService.on('configUpdated', this.handleConfigUpdate.bind(this));
  }

  private setupHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000); // Every 30 seconds
  }

  private async performHealthCheck(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      // Check active streams
      for (const streamPath of this.activeStreams) {
        const sessionId = this.streamSessions.get(streamPath);
        if (sessionId) {
          const session = this.nms.getSession(sessionId);
          if (!session) {
            console.warn(`[Health Check] Lost session for stream ${streamPath}`);
            this.handleStreamDisconnect(sessionId, streamPath);
          }
        }
      }

      // Check VOD service
      const activeRecordings = this.vodService.getActiveRecordings();
      for (const recording of activeRecordings) {
        if (!this.activeStreams.has(recording.streamName)) {
          console.warn(`[Health Check] Found orphaned recording for ${recording.streamName}`);
          this.vodService.stopRecording(recording.streamName);
        }
      }

    } catch (error) {
      console.error('[Health Check] Error during health check:', error);
    }
  }

  private handleConfigUpdate(): void {
    const newConfig = this.configService.getConfig();
    
    // @ts-ignore - Update server config if needed
    if (JSON.stringify(this.nms.config) !== JSON.stringify(newConfig.server)) {
      console.log('[Config] Server configuration changed, restart required');
      this.restart().catch(err => {
        console.error('[Config] Failed to restart server:', err);
      });
    }
  }

  private setupEventHandlers(): void {
    // Node Media Server events
    this.nms.on('preConnect', this.handlePreConnect.bind(this));
    this.nms.on('postConnect', this.handlePostConnect.bind(this));
    this.nms.on('prePublish', this.handlePrePublish.bind(this));
    this.nms.on('postPublish', this.handlePostPublish.bind(this));
    this.nms.on('donePublish', this.handleDonePublish.bind(this));
    this.nms.on('prePlay', this.handlePrePlay.bind(this));
    this.nms.on('postPlay', this.handlePostPlay.bind(this));
    this.nms.on('donePlay', this.handleDonePlay.bind(this));
  }

  private handlePreConnect(id: string, args: any): void {
    console.log(`[Connection] New connection attempt: ${id}`);
  }

  private handlePostConnect(id: string, args: any): void {
    console.log(`[Connection] Client connected: ${id}`);
  }

  private async handlePrePublish(id: string, StreamPath: string): Promise<void> {
    console.log(`[Streaming] New stream preparing: ${StreamPath}`);
    
    if (this.isShuttingDown) {
      console.log(`[Streaming] Server is shutting down, rejecting stream: ${StreamPath}`);
      this.rejectStream(id);
      return;
    }

    // Check if stream is already active
    if (this.activeStreams.has(StreamPath)) {
      console.log(`[Streaming] Stream ${StreamPath} is already active, rejecting new stream`);
      this.rejectStream(id);
      return;
    }

    // Emit event
    this.emit('stream:ready', id, StreamPath);
  }

  private async handlePostPublish(id: string, StreamPath: string): Promise<void> {
    if (!StreamPath.includes('bparty')) {
      return;
    }

    try {
      // Store session mapping
      this.streamSessions.set(StreamPath, id);
      
      // Mark stream as active
      this.activeStreams.add(StreamPath);
      console.log(`[Streaming] New stream started: ${StreamPath}`);
      
      const config = this.configService.getConfig();
      const inputUrl = `rtmp://localhost:${config.server.rtmp.port}${StreamPath}`;

      // Mark streaming started for VOD
      this.vodService.markStreamingStarted(StreamPath);

      // Start VOD recording
      const recordingId = await this.vodService.startRecording(StreamPath, inputUrl);
      if (recordingId) {
        this.emit('vod:started', StreamPath, recordingId);
      }

      // Add delay before starting platform streams
      setTimeout(() => {
        if (this.activeStreams.has(StreamPath)) { // Check if stream is still active
          Object.entries(config.platforms).forEach(([platform, platformConfig]) => {
            this.streamService.startPlatformStream(platform, platformConfig, inputUrl, StreamPath)
              .catch(error => {
                console.error(`[Stream Error] Failed to start ${platform} stream:`, error);
                this.emit('stream:error', id, StreamPath, error);
              });
          });
        }
      }, 1000);

      // Emit event
      this.emit('stream:started', id, StreamPath);

    } catch (error) {
      console.error('[Stream Error]:', error);
      this.activeStreams.delete(StreamPath);
      this.streamSessions.delete(StreamPath);
      this.rejectStream(id);
      this.emit('stream:error', id, StreamPath, error as Error);
    }
  }

  private async handleDonePublish(id: string, StreamPath: string): Promise<void> {
    console.log(`[Streaming] Stream ended: ${StreamPath}`);

    // Stop all platform streams
    this.streamService.stopAllStreams(StreamPath);

    // Stop VOD recording
    this.vodService.stopRecording(StreamPath);

    // Remove from active streams and sessions
    this.activeStreams.delete(StreamPath);
    this.streamSessions.delete(StreamPath);

    // Wait for a second before updating indexes
    const streamName = StreamPath.split('/').pop();
    if (streamName) {
      setTimeout(() => {
        // Double check stream is still inactive before updating
        if (!this.activeStreams.has(StreamPath)) {
          this.vodService.updateRecordingsIndex(streamName);
        }
      }, 1000);
    }

    // Emit event
    this.emit('stream:stopped', id, StreamPath);
  }

  private handlePrePlay(id: string, StreamPath: string): void {
    console.log(`[Playback] New viewer preparing: ${StreamPath}`);
  }

  private handlePostPlay(id: string, StreamPath: string): void {
    console.log(`[Playback] New viewer started: ${StreamPath}`);
  }

  private handleDonePlay(id: string, StreamPath: string): void {
    console.log(`[Playback] Viewer disconnected: ${StreamPath}`);
  }

  private handleStreamDisconnect(id: string, StreamPath: string): void {
    console.log(`[Streaming] Stream disconnected: ${StreamPath}`);
    this.handleDonePublish(id, StreamPath);
  }

  private rejectStream(id: string): void {
    const session = this.nms.getSession(id);
    // @ts-ignore - reject method exists but is not in types
    if (session && typeof session.reject === 'function') {
      // @ts-ignore
      session.reject();
    }
  }

  private setupVodApi(): void {
    const config = this.configService.getConfig();
    
    try {
      // Check if Node Media Server HTTP server is available
      const nmsAny = this.nms as any;
      if (nmsAny.nhs?.app) {
        console.log('[VOD] Using Node Media Server HTTP for VOD API');
        const { app } = nmsAny.nhs;

        this.setupApiMiddleware(app);
        console.log('[VOD] VOD API endpoints initialized on Node Media Server HTTP');
      } else {
        // Create standalone server if NMS HTTP is not available
        console.log('[VOD] Creating standalone VOD API server');
        const app = express();
        const port = config.server.http.port + 1;

        this.setupApiMiddleware(app);

        const server = app.listen(port, () => {
          console.log(`[VOD] Standalone VOD API server running on port ${port}`);
        });

        server.on('error', (error: NodeJS.ErrnoException) => {
          console.error('[VOD] API server error:', error);
          if (error.code === 'EADDRINUSE') {
            console.error(`[VOD] Port ${port} is already in use`);
          }
          this.emit('server:error', error);
        });

        this.vodApiApp = server;
      }
    } catch (error) {
      console.error('[VOD] Failed to setup API server:', error);
      this.emit('server:error', error as Error);
      throw error;
    }
  }

  private setupApiMiddleware(app: express.Application): void {
    const config = this.configService.getConfig();

    // CORS middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', config.server.http.allow_origin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });

    app.use(express.json());
    app.use('/recordings', express.static(config.vod.recordingsDir));
    app.use('/hls', express.static(config.vod.hlsDir));

    const vodApi = new VodApi(config.vod);
    app.use('/api/vod', vodApi.getRouter());

    // Error handling middleware
    app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      console.error('[VOD API Error]:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  public async restart(): Promise<void> {
    console.log('[Server] Restarting...');
    await this.shutdown();
    await new Promise(resolve => setTimeout(resolve, 1000));
    this.start();
  }

  public start(): void {
    if (this.isShuttingDown) {
      throw new Error('Cannot start server while shutdown is in progress');
    }

    this.nms.run();
    this.startupTime = new Date();
    console.log('[Streaming] Server started');

    const config = this.configService.getConfig();
    console.log(`[VOD] VOD system initialized: MP4=${config.vod.recordingFormats.mp4}, HLS=${config.vod.recordingFormats.hls}`);

    if (config.server.http?.port) {
      this.setupVodApi();
    }

    this.emit('server:started');
  }

  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      console.log('Shutdown already in progress...');
      return;
    }

    this.isShuttingDown = true;
    console.log('Shutting down...');

    const shutdownPromises: Promise<void>[] = [];

    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Stop all active streams
    for (const streamPath of this.activeStreams) {
      this.streamService.stopAllStreams(streamPath);
      shutdownPromises.push(
        new Promise(resolve => {
          setTimeout(resolve, 500);
        })
      );
    }

    // Stop all VOD recordings
    this.vodService.stopAllRecordings();

    // Close VOD API server if standalone
    if (this.vodApiApp) {
      shutdownPromises.push(
        new Promise((resolve) => {
          this.vodApiApp?.close(() => {
            console.log('[VOD] Standalone VOD API server closed');
            resolve();
          });
        })
      );
    }

    // Wait for all shutdown operations to complete
    await Promise.all(shutdownPromises);
    
    // Clear active streams set
    this.activeStreams.clear();
    this.streamSessions.clear();

    // Stop the Node Media Server
    if (this.nms) {
      try {
        await new Promise<void>((resolve) => {
          // @ts-ignore - stop method exists but is not in types
          this.nms.stop(() => {
            console.log('[Server] Node Media Server stopped');
            resolve();
          });
        });
      } catch (error) {
        console.error('[Server] Error stopping Node Media Server:', error);
      }
    }

    // Final cleanup delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    this.isShuttingDown = false;
    this.emit('server:stopped');
  }

  // Public utility methods
  public isStreamActive(streamPath: string): boolean {
    return this.activeStreams.has(streamPath);
  }

  public getActiveStreams(): string[] {
    return Array.from(this.activeStreams);
  }

  public getStreamSession(streamPath: string): string | undefined {
    return this.streamSessions.get(streamPath);
  }

  public getVodService(): VodService {
    return this.vodService;
  }

  public getStreamService(): StreamService {
    return this.streamService;
  }

  public getNms(): NodeMediaServer {
    return this.nms;
  }

  public getUptime(): number {
    if (!this.startupTime) return 0;
    return Date.now() - this.startupTime.getTime();
  }

  public getServerStats(): {
    uptime: number;
    activeStreams: number;
    totalConnections: number;
    vodRecordings: number;
  } {
    const activeRecordings = this.vodService.getActiveRecordings();
    return {
      uptime: this.getUptime(),
      activeStreams: this.activeStreams.size,
      // @ts-ignore - sessions is not in types
      totalConnections: Object.keys(this.nms.sessions || {}).length,
      vodRecordings: activeRecordings.length
    };
  }

  public async forceDisconnectStream(streamPath: string): Promise<boolean> {
    const sessionId = this.streamSessions.get(streamPath);
    if (!sessionId) return false;

    try {
      const session = this.nms.getSession(sessionId);
      if (!session) return false;

      // @ts-ignore - reject method exists but is not in types
      if (typeof session.reject === 'function') {
        // @ts-ignore
        session.reject();
        await this.handleDonePublish(sessionId, streamPath);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`[Stream] Error forcing disconnect for ${streamPath}:`, error);
      return false;
    }
  }

  // Event handling with TypeScript support
  public on<K extends keyof StreamerEvents>(
    event: K,
    listener: StreamerEvents[K]
  ): this {
    return super.on(event, listener);
  }

  public once<K extends keyof StreamerEvents>(
    event: K,
    listener: StreamerEvents[K]
  ): this {
    return super.once(event, listener);
  }

  public emit<K extends keyof StreamerEvents>(
    event: K,
    ...args: Parameters<StreamerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}