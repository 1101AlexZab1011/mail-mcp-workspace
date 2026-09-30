// Audio player: waveform (decoded locally), click-to-seek, speed, volume.
const time = (s) => {
  if (!Number.isFinite(s)) return "–:––";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

import { dropdown } from "../shared/page.js";

export async function render(stage, file, { linkFor, setToolbar, h, icon, iconButton }) {
  const link = await linkFor(file.path);
  const audio = h("audio", { src: link.url, preload: "metadata" });
  const canvas = h("canvas", { width: 1400, height: 176, "aria-label": "Waveform; click to seek" });
  const clock = h("span.time", {}, "0:00 / –:––");
  const play = h("button.icon-btn.play", { type: "button", title: "Play (Space)", "aria-label": "Play" }, icon("play_arrow", { fill: true }));
  const speed = dropdown([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => [v, `${v}×`]), 1, (v) => { audio.playbackRate = Number(v); }, { label: "Playback speed" });
  const volume = h("input", { type: "range", min: 0, max: 1, step: 0.01, value: 1, "aria-label": "Volume", style: { width: "96px" } });
  const player = h("div.player", {},
    h("div.now", {}, h("div.art", {}, icon("music_note")), h("div", { style: { minWidth: 0 } }, h("div.track", {}, file.name), h("div.sub", {}, file.path))),
    canvas,
    h("div.controls", {}, play, iconButton("replay_10", "Back 10 s", () => { audio.currentTime -= 10; }, { small: true }), iconButton("forward_10", "Forward 10 s", () => { audio.currentTime += 10; }, { small: true }), clock, h("span", { style: { flex: 1 } }), icon("volume_up", { size: 18 }), volume, speed),
    audio,
  );
  stage.replaceChildren(h("div.media", {}, player));

  let peaks = null;
  const styles = getComputedStyle(document.documentElement);
  function draw() {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    const bars = peaks ?? new Array(280).fill(0.08);
    const bar = width / bars.length;
    bars.forEach((peak, i) => {
      const barHeight = Math.max(4, peak * height * 0.92);
      ctx.fillStyle = i / bars.length < progress ? styles.getPropertyValue("--mw-primary") : styles.getPropertyValue("--mw-border-strong");
      ctx.beginPath();
      ctx.roundRect(i * bar + 1, (height - barHeight) / 2, Math.max(1, bar - 3), barHeight, 3);
      ctx.fill();
    });
  }
  // Decode for the waveform only when the file is a reasonable size.
  if (link.size < 60 * 1024 * 1024) {
    fetch(link.url).then((r) => r.arrayBuffer()).then((data) => new AudioContext().decodeAudioData(data)).then((buffer) => {
      const channel = buffer.getChannelData(0);
      const count = 280;
      const step = Math.floor(channel.length / count);
      const raw = Array.from({ length: count }, (_, i) => { let max = 0; for (let j = i * step; j < (i + 1) * step; j += 16) max = Math.max(max, Math.abs(channel[j])); return max; });
      const top = Math.max(...raw) || 1;
      peaks = raw.map((v) => v / top);
      draw();
    }).catch(() => {});
  }
  const toggle = () => (audio.paused ? audio.play() : audio.pause());
  play.addEventListener("click", toggle);
  audio.addEventListener("play", () => { play.replaceChildren(icon("pause", { fill: true })); play.title = "Pause (Space)"; });
  audio.addEventListener("pause", () => { play.replaceChildren(icon("play_arrow", { fill: true })); play.title = "Play (Space)"; });
  audio.addEventListener("timeupdate", () => { clock.textContent = `${time(audio.currentTime)} / ${time(audio.duration)}`; draw(); });
  audio.addEventListener("loadedmetadata", () => { clock.textContent = `0:00 / ${time(audio.duration)}`; });
  canvas.addEventListener("click", (event) => { const rect = canvas.getBoundingClientRect(); if (audio.duration) audio.currentTime = ((event.clientX - rect.left) / rect.width) * audio.duration; });
  volume.addEventListener("input", () => { audio.volume = Number(volume.value); });
  setToolbar();
  draw();
  return {
    state: () => ({ playing: !audio.paused, position: audio.currentTime, duration: audio.duration, rate: audio.playbackRate }),
    command: (action, args) => {
      if (action === "play") audio.play(); else if (action === "pause") audio.pause();
      else if (action === "seek") audio.currentTime = Number(args.seconds);
      else if (action === "rate") { audio.playbackRate = Number(args.rate); speed.value = Number(args.rate); }
      else throw new Error(`Unknown audio action ${action}`);
      return { playing: !audio.paused, position: audio.currentTime };
    },
    onKey: (event) => { if (event.key === " ") { event.preventDefault(); toggle(); } if (event.key === "ArrowRight") audio.currentTime += 5; if (event.key === "ArrowLeft") audio.currentTime -= 5; },
    dispose: () => audio.pause(),
  };
}
