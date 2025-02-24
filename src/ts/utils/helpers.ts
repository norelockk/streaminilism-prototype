import { RecordingMetadata } from "../types";

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