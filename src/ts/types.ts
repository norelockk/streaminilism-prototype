import { FfmpegCommand } from 'fluent-ffmpeg';

export interface StreamOptions {
  input: string[];
  output: string[];
}

export interface PlatformConfig {
  url: string;
  key: string;
  options: StreamOptions;
}

export interface ServerConfig {
  http: {
    port: number;
    allow_origin: string;
    mediaroot: string;
  };
  rtmp: {
    port: number;
    chunk_size: number;
    gop_cache: boolean;
    ping: number;
    ping_timeout: number;
    timeout: number;
  };
  auth: {
    api: boolean;
    api_user: string;
    api_pass: string;
    play: boolean;
    publish: boolean;
  };
}

export interface VodConfig {
  recordingsDir: string;
  hlsDir: string;
  segmentLength: number;
  playlistLength: number;
  recordingFormats: {
    mp4: boolean;
    hls: boolean;
  };
  mp4Options: StreamOptions;
  hlsOptions: StreamOptions;
  retention: {
    days: number;
    cleanupInterval: number;
  };
}

export interface CDNConfig {
  url: string;
  enabled: boolean;
  provider: 'bunny';
  credentials: {
    storageKey: string;
    storageZone: string;
  };
  options: {
    maxConcurrentUploads: number;
    retryAttempts: number;
    retryDelay: number;
  };
  paths: {
    recordings: string;
    hls: string;
  };
}

export interface AppConfig {
  server: ServerConfig;
  platforms: Record<string, PlatformConfig>;
  vod: VodConfig;
  cdn: CDNConfig;
}

export interface RecordingFormat {
  type: 'mp4' | 'hls';
  path: string;
  webPath: string;
  cdnUrl?: string;
}

export interface RecordingMetadata {
  streamPath: string;
  recordingId: string;
  startTime: string;
  endTime?: string;
  duration?: number;  // Duration in seconds
  formats: RecordingFormat[];
}

export interface StreamIndex {
  streamName: string;
  lastUpdated: string;
  recordings: RecordingMetadata[];
}

export interface MasterIndexStream {
  name: string;
  recordingCount: number;
  lastRecording: string | null;
  indexPath: string;
}

export interface MasterIndex {
  lastUpdated: string;
  streams: MasterIndexStream[];
}