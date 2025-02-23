import { AppConfig, RecordingMetadata } from './types';

export function sanitizeRecordingsIndex(recordings: RecordingMetadata[]): RecordingMetadata[] {
  // Remove duplicates using Map with recordingId as key
  const uniqueRecordings = new Map<string, RecordingMetadata>();

  recordings.forEach(recording => {
    if (!uniqueRecordings.has(recording.recordingId)) {
      uniqueRecordings.set(recording.recordingId, recording);
    }
  });

  // Convert Map back to array and sort by startTime (newest first)
  return Array.from(uniqueRecordings.values())
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
}

export function humanReadable(bytes: number)
{
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;

  while (bytes >= 1024) {
    bytes /= 1024;
    i++;
  }

  return `${bytes.toFixed(2)} ${units[i]}`;
}

export const defaultConfig: AppConfig = {
  cdn: {
    url: 'https://cdn.example.com',
    enabled: false,
    provider: 'bunny',
    credentials: {
      storageKey: '',
      storageZone: ''
    },
    options: {
      maxConcurrentUploads: 3,
      retryAttempts: 3,
      retryDelay: 5000
    },
    paths: {
      recordings: '/recordings',
      hls: '/hls'
    }
  },
  server: {
    http: {
      port: 8000,
      allow_origin: '*',
      mediaroot: './media'
    },
    rtmp: {
      port: 1337,
      chunk_size: 128000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 120,
      timeout: 120
    },
    auth: {
      api: false,
      api_user: 'admin',
      api_pass: 'admin',
      play: false,
      publish: false
    }
  },
  platforms: {
    twitch_example: {
      url: 'rtmp://ingest.global-contribute.live-video.net/app',
      key: '',
      options: {
        input: [
          '-thread_queue_size', '512',
          '-fflags', '+genpts',
          '-analyzeduration', '5000000',
          '-probesize', '5000000'
        ],
        output: [
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-profile:v', 'baseline',
          '-tune', 'film',
          '-b:v', '1500k',
          '-maxrate', '1800k',
          '-bufsize', '4000k',
          '-pix_fmt', 'yuv420p',
          '-g', '60',
          '-r', '30',
          '-force_key_frames', 'expr:gte(t,n_forced*1.5)',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          '-f', 'flv',
          '-flvflags', 'no_duration_filesize',
          '-shortest',
          '-xerror',
          '-threads', '4'
        ]
      }
    }
  },
  vod: {
    recordingsDir: './recordings',
    hlsDir: './media/hls',
    segmentLength: 6,
    playlistLength: 60,
    recordingFormats: {
      mp4: true,
      hls: true
    },
    mp4Options: {
      input: [
        '-thread_queue_size', '512',
        '-fflags', '+genpts',
        '-analyzeduration', '5000000',
        '-probesize', '5000000'
      ],
      output: [
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '320k',
        '-ar', '48000',
        '-movflags', '+faststart'
      ]
    },
    hlsOptions: {
      input: [
        '-thread_queue_size', '512',
        '-fflags', '+genpts',
        '-analyzeduration', '5000000',
        '-probesize', '5000000'
      ],
      output: [
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '320k',
        '-ar', '48000'
      ]
    },
    retention: {
      days: 30,
      cleanupInterval: 86400
    }
  }
};

