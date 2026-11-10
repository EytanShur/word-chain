/**
 * A "memory": the front camera films the team from the countdown until time's up, with the clock and
 * the current word drawn onto every frame, then a short end card that says where to play. Frames are
 * composed on a canvas and recorded live, so the clip is ready the moment the round ends. Nothing is
 * uploaded; the clip only leaves the phone through the share sheet.
 */

const W = 720;
const H = 1280;
/** Aim for clips of about this size whatever the round length, so they share easily. */
const TARGET_BYTES = 13 * 1024 * 1024;
const AUDIO_BITRATE = 128_000;
const END_CARD_MS = 1600;
/** The mic is quiet next to the speaker; double it so voices carry. */
const MIC_GAIN = 2;

const MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/** On iPhone, "playback" keeps sounds on with the silent switch; recording needs "play-and-record". */
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* not Safari */ }
}
setAudioSession('playback');

async function openCamera() {
  const video = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: { echoCancellation: false, noiseSuppression: false } });
  } catch {
    // The camera alone still makes a memory when the microphone is refused.
    return navigator.mediaDevices.getUserMedia({ video });
  }
}

const formatTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const dollars = n => '$' + n.toLocaleString('en-US');

export class Memory {
  /** The live camera stream while a round is being filmed (for the small preview). */
  stream = null;
  /** True from start() until finish() resolves or discard(). */
  active = false;
  /** True while the recorder runs; game sounds play quieter then. */
  recording = false;
  /** Resolves to whether filming actually started. */
  ready = Promise.resolve(false);

  /** Bumped by discard(), so a camera that finishes opening after it is let go. */
  #session = 0;
  #round = null;
  #recorder = null;
  #chunks = [];
  #video = null;
  #canvas = null;
  #ctx = null;
  #frame = 0;
  #mic = null;
  #endCard = false;
  #url = null;

  static supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder &&
      HTMLCanvasElement.prototype.captureStream && window.isSecureContext);
  }

  /** Asks for the camera (and microphone) once, then lets go of them. Resolves to whether the camera is allowed. */
  async requestPermission() {
    if (!Memory.supported()) return false;
    setAudioSession('play-and-record');
    try {
      const s = await openCamera();
      s.getTracks().forEach(t => t.stop());
      return true;
    } catch {
      return false;
    } finally {
      setAudioSession('playback');
    }
  }

  /** Starts filming; [round] is read every frame for the clock, word and final total. */
  start(round) {
    this.discard();
    if (!Memory.supported()) return;
    this.active = true;
    this.#round = round;
    const session = this.#session;
    this.ready = this.#open(session).catch(() => {
      if (session === this.#session) this.discard();
      return false;
    });
  }

  async #open(session) {
    setAudioSession('play-and-record');
    const stream = await openCamera();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
    } finally {
      // Discarded (or restarted) while the camera was opening: let go of it.
      if (session !== this.#session) stream.getTracks().forEach(t => t.stop());
    }
    if (session !== this.#session) return false;
    this.stream = stream;
    this.#video = video;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.#draw();

    const tracks = [canvas.captureStream(30).getVideoTracks()[0]];
    if (stream.getAudioTracks().length) {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ac.createGain();
      gain.gain.value = MIC_GAIN;
      const dest = ac.createMediaStreamDestination();
      ac.createMediaStreamSource(stream).connect(gain).connect(dest);
      tracks.push(dest.stream.getAudioTracks()[0]);
      this.#mic = ac;
    }

    const mimeType = MIME_TYPES.find(t => MediaRecorder.isTypeSupported(t));
    const seconds = this.#round.duration + 10; // countdown, time's up and the end card
    const videoBitsPerSecond = Math.round(Math.min(4_000_000, Math.max(500_000, TARGET_BYTES * 8 / seconds - AUDIO_BITRATE)));
    const recorder = new MediaRecorder(new MediaStream(tracks), {
      ...(mimeType ? { mimeType } : {}), videoBitsPerSecond, audioBitsPerSecond: AUDIO_BITRATE,
    });
    this.#chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) this.#chunks.push(e.data); };
    recorder.start(1000);
    this.#recorder = recorder;
    this.recording = true;
    return true;
  }

  #draw = () => {
    const c = this.#ctx;
    if (!c) return;
    if (this.#endCard) {
      drawEndCard(c, this.#round.total);
    } else {
      const v = this.#video;
      c.fillStyle = '#000';
      c.fillRect(0, 0, W, H);
      if (v.videoWidth) {
        const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
        const dw = v.videoWidth * scale;
        const dh = v.videoHeight * scale;
        c.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      }
      drawOverlay(c, this.#round);
    }
    this.#frame = requestAnimationFrame(this.#draw);
  };

  /** Shows the end card, stops filming and resolves to the clip ({blob, url, type, name}) or null. */
  async finish() {
    const ok = await this.ready;
    const recorder = this.#recorder;
    if (!ok || !recorder || !this.active) return null;
    this.#endCard = true;
    await new Promise(r => setTimeout(r, END_CARD_MS));
    if (this.#recorder !== recorder) return null; // discarded meanwhile
    const stopped = new Promise(r => { recorder.onstop = r; });
    recorder.stop();
    this.recording = false;
    await stopped;
    if (this.#recorder !== recorder) return null;
    const type = (recorder.mimeType || 'video/webm').split(';')[0];
    const blob = new Blob(this.#chunks, { type });
    this.#release();
    this.#url = URL.createObjectURL(blob);
    const name = `word-chain-memory.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    this.active = false;
    return { blob, url: this.#url, type, name };
  }

  /** Opens the share sheet, or downloads the clip where sharing files is not supported. Returns a note for the player. */
  async share(clip) {
    const file = new File([clip.blob], clip.name, { type: clip.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Word Chain' });
        return '';
      } catch (e) {
        if (e.name === 'AbortError') return '';
      }
    }
    const a = document.createElement('a');
    a.href = clip.url;
    a.download = clip.name;
    document.body.append(a);
    a.click();
    a.remove();
    return 'Saved to your downloads.';
  }

  /** Stops filming and forgets the clip. */
  discard() {
    this.#session++;
    const recorder = this.#recorder;
    this.#recorder = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    this.#release();
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = null;
    this.#chunks = [];
    this.#round = null;
    this.active = false;
    this.ready = Promise.resolve(false);
  }

  #release() {
    cancelAnimationFrame(this.#frame);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.#mic?.close().catch(() => {});
    this.#mic = null;
    if (this.#video) this.#video.srcObject = null;
    this.#video = null;
    this.#ctx = null;
    this.#canvas = null;
    this.#endCard = false;
    this.recording = false;
    setAudioSession('playback');
  }
}

function shadow(c, blur, y) {
  c.shadowColor = 'rgba(0,0,0,0.8)';
  c.shadowBlur = blur;
  c.shadowOffsetY = y;
}
function noShadow(c) {
  c.shadowColor = 'transparent';
  c.shadowBlur = 0;
  c.shadowOffsetY = 0;
}

/** The clock at the top and the current word in a clue tile at the bottom, as in the game. */
function drawOverlay(c, round) {
  const started = round.phase !== 'ready';
  const over = round.phase === 'over';
  const clock = !started ? 'GET READY' : over ? "TIME'S UP!" : formatTime(round.secondsLeft);
  const urgent = started && !over && round.secondsLeft <= 10;

  let g = c.createLinearGradient(0, 0, 0, 330);
  g.addColorStop(0, 'rgba(0,0,0,0.67)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, W, 330);

  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.font = `${clock.length > 5 ? 96 : 150}px Anton`;
  c.fillStyle = urgent ? '#E11D2B' : '#FFCC00';
  shadow(c, 12, 6);
  c.fillText(clock, W / 2, 200);
  noShadow(c);

  if (!started || !round.word) return;
  g = c.createLinearGradient(0, H - 440, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.67)');
  c.fillStyle = g;
  c.fillRect(0, H - 440, W, 440);

  const x = 40, y = H - 300, w = W - 80, h = 200;
  c.beginPath();
  c.roundRect(x, y, w, h, 16);
  c.fillStyle = '#0A11B8';
  c.fill();
  c.lineWidth = 8;
  c.strokeStyle = '#000';
  c.stroke();

  const word = round.word.toUpperCase();
  let size = 120;
  c.font = `${size}px Anton`;
  while (size > 30 && c.measureText(word).width > w - 50) {
    size -= 4;
    c.font = `${size}px Anton`;
  }
  c.textBaseline = 'middle';
  c.fillStyle = '#fff';
  shadow(c, 8, 4);
  c.fillText(word, W / 2, y + h / 2 + 4);
  noShadow(c);
}

/** Closing card: the game's name, what the team won, and where anyone can play it. */
function drawEndCard(c, total) {
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2A33F5');
  g.addColorStop(0.5, '#060CE9');
  g.addColorStop(1, '#02045E');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  // The two chain links of the app icon.
  c.lineWidth = 16;
  c.strokeStyle = '#FFCC00';
  for (const dx of [-56, 56]) {
    c.beginPath();
    c.roundRect(W / 2 + dx - 96, 300, 192, 120, 60);
    c.stroke();
  }

  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  shadow(c, 12, 6);
  c.fillStyle = '#FFCC00';
  c.font = '120px Anton';
  c.fillText('WORD CHAIN', W / 2, 600);
  c.fillStyle = '#fff';
  c.font = '48px Bebas';
  c.fillText('THE PARTY GAME SHOW', W / 2, 668);

  if (total > 0) {
    c.font = '56px Bebas';
    c.fillText('WE WON', W / 2, 820);
    c.fillStyle = '#FFCC00';
    c.font = '130px Anton';
    c.fillText(dollars(total), W / 2, 970);
  }

  const where = (location.host + location.pathname).replace(/index\.html$/, '').replace(/\/$/, '');
  c.fillStyle = 'rgba(255,255,255,0.75)';
  c.font = '44px Bebas';
  c.fillText('PLAY FREE AT', W / 2, 1120);
  c.fillStyle = '#fff';
  let size = 56;
  c.font = `${size}px Bebas`;
  while (size > 28 && c.measureText(where).width > W - 60) {
    size -= 2;
    c.font = `${size}px Bebas`;
  }
  c.fillText(where, W / 2, 1180);
  noShadow(c);
}
