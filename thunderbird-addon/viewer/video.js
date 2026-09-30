// Video: the platform player (with range requests from the host) and speed.
export async function render(stage, file, { linkFor, setToolbar, h }) {
  const link = await linkFor(file.path);
  const video = h("video", { src: link.url, controls: true, preload: "metadata", playsinline: true });
  stage.replaceChildren(h("div.media", {}, video));
  const speed = h("select.input", { "aria-label": "Speed", style: { height: "30px" } }, ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => h("option", { value: v, selected: v === 1 }, `${v}×`)));
  speed.addEventListener("change", () => { video.playbackRate = Number(speed.value); });
  const info = h("span.label", {});
  video.addEventListener("loadedmetadata", () => { info.textContent = `${video.videoWidth} × ${video.videoHeight}`; });
  video.addEventListener("error", () => { info.textContent = "This video format cannot be played here"; });
  setToolbar(info, h("span.spacer"), speed);
  return {
    state: () => ({ playing: !video.paused, position: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight }),
    command: (action, args) => {
      if (action === "play") video.play(); else if (action === "pause") video.pause();
      else if (action === "seek") video.currentTime = Number(args.seconds);
      else if (action === "rate") video.playbackRate = Number(args.rate);
      else throw new Error(`Unknown video action ${action}`);
      return { playing: !video.paused, position: video.currentTime };
    },
    onKey: (event) => { if (event.key === " " && event.target === document.body) { event.preventDefault(); if (video.paused) video.play(); else video.pause(); } },
    dispose: () => video.pause(),
  };
}
