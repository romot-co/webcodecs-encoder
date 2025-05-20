import { MediaStreamRecorder } from 'webcodecs-muxer';

const recorder = new MediaStreamRecorder(config);
await recorder.startRecording(stream);
const result = await recorder.stopRecording();
