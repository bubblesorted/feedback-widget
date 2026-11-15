/**
 * A screen recording: the selected element through Chrome's region
 * capture (CropTarget, the current tab), or a shared tab or window chosen explicitly. Never a silent fallback from the
 * element to the whole screen. Narration only when asked for. Stops at 45 seconds or 12 MB.
 */

import { MAX_ASSET_BYTES, MAX_RECORDING_MS } from "../contract";

interface CroppableTrack extends MediaStreamTrack {
  cropTo?: (target: unknown) => Promise<void>;
}
interface CaptureWindow extends Window {
  CropTarget?: { fromElement: (element: Element) => Promise<unknown> };
}
export interface Recording {
  stop: () => void;
  finished: Promise<Blob>;
}

export function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
}

export function canCropToElement(): boolean {
  return typeof window !== "undefined" && !!(window as CaptureWindow).CropTarget;
}

export async function startRecording(element: Element | null, narration: boolean): Promise<Recording> {
  if (!canRecord()) throw new Error("Screen recording needs a desktop browser with screen sharing. Element images still work here.");
  const crop = (window as CaptureWindow).CropTarget;
  if (element && !crop) throw new Error("This browser cannot crop a recording to an element. Choose Shared tab or window, or use Chrome.");
  const streams: MediaStream[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
  };
  try {
    const options: DisplayMediaStreamOptions & { preferCurrentTab: boolean } = { video: { frameRate: 20 }, audio: false, preferCurrentTab: true };
    const screen = await navigator.mediaDevices.getDisplayMedia(options);
    streams.push(screen);
    const track = screen.getVideoTracks()[0] as CroppableTrack | undefined;
    if (!track) throw new Error("The browser shared no video.");
    if (element) {
      if (!element.isConnected || !track.cropTo || !crop) throw new Error("Element cropping is not available. Choose this tab when sharing.");
      try {
        await track.cropTo(await crop.fromElement(element));
      } catch {
        throw new Error("The recording could not be cropped to the element. Choose this tab when sharing, or choose Shared tab or window.");
      }
    }
    if (narration) {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      streams.push(microphone);
      for (const audio of microphone.getAudioTracks()) screen.addTrack(audio);
    }
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser cannot save a supported recording.");
    const recorder = new MediaRecorder(screen, { mimeType, videoBitsPerSecond: 1_000_000 });
    const chunks: Blob[] = [];
    let bytes = 0;
    const stop = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          bytes += event.data.size;
        }
        if (bytes > MAX_ASSET_BYTES) stop();
      };
      recorder.onerror = () => {
        cleanup();
        reject(new Error("The recording failed. Try again."));
      };
      recorder.onstop = () => {
        cleanup();
        if (!bytes || bytes > MAX_ASSET_BYTES) reject(new Error("The recording was empty or over 12 MB. Try a shorter one."));
        else resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
      };
    });
    track.addEventListener("ended", stop, { once: true });
    recorder.start(250);
    timer = setTimeout(stop, MAX_RECORDING_MS);
    return { stop, finished };
  } catch (error) {
    cleanup();
    throw error;
  }
}
