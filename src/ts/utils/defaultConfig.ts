import { AppConfig } from '../types';

export const defaultConfig: AppConfig = {
  cdn: {
    url: 'https://cdn.example.com',
    paths: {
      recordings: '/recordings',
      hls: '/hls'
    },
    options: {
      maxConcurrentUploads: 3,
      retryAttempts: 3,
      retryDelay: 5000
    },
    enabled: false,
    provider: 'bunny',
    credentials: {
      storageKey: '',
      storageZone: ''
    }
  },
  
  vod: {
    hlsDir: './media/hls',
    retention: {
      days: 30,
      cleanupInterval: 86400
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
    recordingsDir: './recordings',
    segmentLength: 6,
    playlistLength: 60,
    recordingFormats: {
      mp4: true,
      hls: true
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
  }
};