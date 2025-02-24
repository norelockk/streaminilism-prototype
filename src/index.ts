import { MultiPlatformStreamer } from './ts/components/stream';

// Create and start the streamer
const streamer = new MultiPlatformStreamer();

// Stream Events
streamer.on('stream:ready', (id, streamPath) => {
  console.log(`[Event] Stream ready: ${streamPath} (ID: ${id})`);
});

streamer.on('stream:started', (id, streamPath) => {
  console.log(`[Event] Stream started: ${streamPath} (ID: ${id})`);
});

streamer.on('stream:stopped', (id, streamPath) => {
  console.log(`[Event] Stream stopped: ${streamPath} (ID: ${id})`);
});

streamer.on('stream:error', (id, streamPath, error) => {
  console.error(`[Event] Stream error for ${streamPath} (ID: ${id}):`, error);
});

// VOD Events
streamer.on('vod:started', (streamPath, recordingId) => {
  console.log(`[Event] VOD recording started: ${streamPath} (Recording: ${recordingId})`);
});

streamer.on('vod:stopped', (streamPath, recordingId) => {
  console.log(`[Event] VOD recording stopped: ${streamPath} (Recording: ${recordingId})`);
});

streamer.on('vod:error', (streamPath, error) => {
  console.error(`[Event] VOD error for ${streamPath}:`, error);
});

// Server Events
streamer.on('server:started', () => {
  console.log('[Event] Streaming server started');
});

streamer.on('server:stopped', () => {
  console.log('[Event] Streaming server stopped');
});

streamer.on('server:error', (error) => {
  console.error('[Event] Server error:', error);
});

// Start the server
streamer.start();

// Handle graceful shutdown
const handleShutdown = async () => {
  console.log('Received shutdown signal...');
  await streamer.shutdown();
  process.exit(0);
};

// Handle various exit signals
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('SIGHUP', handleShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  handleShutdown().catch((err) => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
  handleShutdown().catch((err) => {
    console.error('Error during shutdown:', err);
    process.exit(1);
  });
});