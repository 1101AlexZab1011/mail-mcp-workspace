// Video: the platform player (with range requests from the host) and speed.
import { dropdown } from "../shared/page.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => [v, `${v}×`]);

export async function render(stage, file, { linkFor, setToolbar, h }) {
  const link = await linkFor(file.path);
  const video = h("video", { src: link.url, controls: true, preload: "metadata", playsinline: true });
  stage.replaceChildren(h("div.media", {}, video));
  const speed = dropdown(SPEEDS, 1, (v) => { video.playbackRate = Number(v); }, { label: "Playback speed" });
  const info = h("span.label", {});
  video.addEventListener("loadedmetadata", () => { info.textContent = `${video.videoWidth} × ${video.videoHeight}`; });
  video.addEventListener("error", () => { info.textContent = "This video format cannot be played here"; });
  setToolbar(info, h("span.spacer"), speed);
  return {
    state: () => ({ playing: !video.paused, position: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight }),
    command: (action, args) => {
      if (action === "play") video.play(); else if (action === "pause") video.pause();
      else if (action === "seek") video.currentTime = Number(args.seconds);
      else if (action === "rate") { video.playbackRate = Number(args.rate); speed.value = Number(args.rate); }
      else throw new Error(`Unknown video action ${action}`);
      return { playing: !video.paused, position: video.currentTime };
    },
    onKey: (event) => { if (event.key === " " && event.target === document.body) { event.preventDefault(); if (video.paused) video.play(); else video.pause(); } },
    dispose: () => video.pause(),
  };
}
