// Speech-to-text (mic dictation) for the composer.
// Port of an Angular SpeechToText directive to Svelte 5 runes: it wraps
// the Web Speech API, exposes a reactive `state`, and appends the live
// transcript to whatever text the composer already holds.
//
// States mirror the Angular version:
//   idle          — ready, click the mic to start
//   listening     — recording, interim results stream in
//   need-download — on-device model available but not installed (Chrome)
//   downloading   — installing the on-device model
//   disabled      — unsupported browser or mic permission denied
//   failed        — the recognizer started but produced nothing usable

// Resolved per call (not at module load) so a late polyfill still counts.
function resolveSR() {
  return typeof globalThis !== 'undefined'
    ? globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition
    : undefined;
}

export function createSpeechToText({ lang, onText } = {}) {
  const SR = resolveSR();
  if (!SR) return new UnsupportedSpeech();
  return new Speech({ SR, lang: lang || navigator.language || 'en-US', onText });
}

class UnsupportedSpeech {
  get state() {
    return 'disabled';
  }
  toggle() {}
  dismissFailure() {}
  destroy() {}
}

class Speech {
  #SR;
  #hasOnDevice;
  #rec;
  #onText;
  #options;

  // reactive signals feeding the computed `state`
  #listening = $state(false);
  #downloading = $state(false);
  #availability = $state('available');
  #micPermission = $state('unknown');
  #runtimeFailed = $state(false);
  #failureDismissed = $state(false);

  // transcript-binding: the composer text captured when listening starts, so
  // the streaming transcript is appended to it rather than overwriting it.
  #base = '';

  // runtime-failure bookkeeping (Arc & friends quirks — see below)
  #stopRequested = false;
  #sawSpeech = false;
  #sawResult = false;
  #hangTimer = null;

  constructor({ SR, lang, onText }) {
    this.#SR = SR;
    // Chrome's on-device API adds static `available`/`install` + a
    // `processLocally` option. Older engines (Safari, forks) lack them → the
    // recognizer is treated as immediately available.
    this.#hasOnDevice = typeof SR.available === 'function' && typeof SR.install === 'function';
    this.#onText = onText;
    this.#options = { langs: [lang], processLocally: true };
    this.#rec = new SR();
    this.#rec.lang = lang;
    this.#rec.interimResults = true;
    if (this.#hasOnDevice) {
      this.#availability = 'unknown';
      this.#rec.processLocally = true;
    }

    this.#wire();
    this.#refreshAvailability();
    this.#watchMicPermission();
  }

  get #enabled() {
    if (this.#micPermission === 'denied') return false;
    const a = this.#availability;
    return a === 'available' || a === 'downloadable' || a === 'downloading';
  }

  get state() {
    if (this.#runtimeFailed) return this.#failureDismissed ? 'disabled' : 'failed';
    if (!this.#enabled) return 'disabled';
    if (this.#downloading) return 'downloading';
    if (this.#listening) return 'listening';
    if (this.#availability === 'downloadable') return 'need-download';
    return 'idle';
  }

  // `currentText` is the composer value at click time; snapshotted as the base
  // the transcript gets appended to.
  toggle(currentText = '') {
    switch (this.state) {
      case 'listening':
        this.#stopRequested = true;
        this.#rec.stop();
        break;
      case 'need-download':
        void this.#download();
        break;
      case 'idle':
        this.#base = currentText;
        this.#rec.start();
        break;
      default:
        break;
    }
  }

  dismissFailure() {
    if (this.state === 'failed') this.#failureDismissed = true;
  }

  destroy() {
    clearTimeout(this.#hangTimer);
    try {
      this.#stopRequested = true;
      this.#rec.abort();
    } catch {
      // already stopped
    }
  }

  async #refreshAvailability() {
    if (!this.#hasOnDevice) return;
    try {
      this.#availability = await this.#SR.available(this.#options);
    } catch {
      this.#availability = 'unknown';
    }
  }

  async #download() {
    this.#downloading = true;
    try {
      await this.#SR.install(this.#options);
      await this.#refreshAvailability();
    } catch {
      // stays downloadable; user can retry
    } finally {
      this.#downloading = false;
    }
  }

  async #watchMicPermission() {
    if (!navigator.permissions?.query) return;
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      this.#micPermission = status.state;
      status.addEventListener('change', () => {
        this.#micPermission = status.state;
      });
    } catch {
      // permission API not available for microphone; leave as 'unknown'
    }
  }

  #wire() {
    const rec = this.#rec;

    rec.addEventListener('start', () => {
      this.#listening = true;
      this.#stopRequested = false;
      this.#sawSpeech = false;
      this.#sawResult = false;
    });
    rec.addEventListener('speechstart', () => {
      this.#sawSpeech = true;
    });
    rec.addEventListener('result', (e) => {
      this.#sawResult = true;
      // Index-based access (MDN canonical): SpeechRecognitionResult(List) are
      // array-like but not reliably iterable across engines — spreading them
      // throws on Safari/forks and the transcript would never reach the field.
      let transcript = '';
      for (let i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0]?.transcript ?? '';
      }
      transcript = transcript.trim();
      const sep = this.#base && transcript ? ' ' : '';
      this.#onText?.(this.#base + sep + transcript);
    });
    rec.addEventListener('end', () => {
      this.#listening = false;
      // Speech was detected but no transcript came back and the user did not
      // stop the session himself → the recognizer is unusable. Arc ends such
      // sessions cleanly, without any error event.
      if (!this.#stopRequested && this.#sawSpeech && !this.#sawResult) {
        this.#runtimeFailed = true;
      }
    });
    rec.addEventListener('error', (e) => {
      this.#listening = false;
      const fatal = e.error === 'language-not-supported' || e.error === 'service-not-allowed';
      // An abort we did not ask for (Arc kills on-device sessions right after
      // start) also means the recognizer is unusable.
      const spontaneousAbort = e.error === 'aborted' && !this.#stopRequested;
      if (fatal || spontaneousAbort) this.#runtimeFailed = true;
    });

    // Arc (and possibly other Chromium forks) report on-device recognition as
    // available but never emit result/end/error after audio stops: detect the
    // silent hang and force-fail.
    rec.addEventListener('audioend', () => {
      clearTimeout(this.#hangTimer);
      this.#hangTimer = setTimeout(() => {
        if (this.#sawResult) return;
        this.#stopRequested = true;
        try {
          this.#rec.abort();
        } catch {
          // already gone
        }
        this.#runtimeFailed = true;
      }, 2000);
    });
    const clearHang = () => clearTimeout(this.#hangTimer);
    rec.addEventListener('result', clearHang);
    rec.addEventListener('end', clearHang);
    rec.addEventListener('error', clearHang);
  }
}
