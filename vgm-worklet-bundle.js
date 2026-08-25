/*
 * AudioWorkletProcessor that drives the YM2203 emulator sample-by-sample,
 * consuming pre-parsed VGM events at the correct sample offsets.
 *
 * VGM files are authored at 44100 Hz sample timing regardless of actual
 * output sample rate, so we run an internal 44100 Hz clock and resample
 * to the AudioContext's sampleRate via simple linear interpolation if needed.
 */

// classes YM2203 / VGMParser are inlined below since AudioWorklet modules
// cannot easily `importScripts` in all browsers reliably from blob URLs;
// the main thread injects the source via addModule with concatenated code.

class VGMPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { vgmSampleRate } = options.processorOptions || {};
    this.vgmRate = vgmSampleRate || 44100;
    this.chip = new YM2203(this.vgmRate, 3993600);
    this.events = [];
    this.eventIndex = 0;
    this.totalSamples = 0;
    this.loopSampleOffset = -1;
    this.currentSample = 0;
    this.playing = false;
    this.loopEnabled = true;
    this.ended = false;

    this.outAccumPos = 0; // fractional position for resampling
    this.lastL = 0;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'load':
        this.events = msg.events;
        this.totalSamples = msg.totalSamples;
        this.loopSampleOffset = msg.loopSampleOffset;
        this.eventIndex = 0;
        this.currentSample = 0;
        this.chip = new YM2203(this.vgmRate, msg.clock || 3993600);
        this.ended = false;
        this.playing = false;
        this.port.postMessage({ type: 'loaded' });
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seekSample':
        this._seek(msg.sample);
        break;
      case 'setLoop':
        this.loopEnabled = msg.value;
        break;
      case 'stop':
        this.playing = false;
        this.currentSample = 0;
        this.eventIndex = 0;
        this.chip = new YM2203(this.vgmRate, this.chip.clock);
        break;
    }
  }

  _seek(targetSample) {
    // Re-run from start applying all register writes up to targetSample (fast-forward, silent)
    this.chip = new YM2203(this.vgmRate, this.chip.clock);
    let i = 0;
    while (i < this.events.length && this.events[i].sampleOffset <= targetSample) {
      const ev = this.events[i];
      if (ev.type === 'ym2203') this.chip.write(ev.addr, ev.data);
      i++;
    }
    this.eventIndex = i;
    this.currentSample = targetSample;
  }

  _advanceOneVgmSample() {
    // Apply all events scheduled at exactly this sample position
    while (this.eventIndex < this.events.length && this.events[this.eventIndex].sampleOffset <= this.currentSample) {
      const ev = this.events[this.eventIndex];
      if (ev.type === 'ym2203') {
        this.chip.write(ev.addr, ev.data);
      } else if (ev.type === 'end') {
        if (this.loopEnabled && this.loopSampleOffset >= 0) {
          this.currentSample = this.loopSampleOffset;
          // find event index corresponding to loop point
          let li = 0;
          while (li < this.events.length && this.events[li].sampleOffset < this.loopSampleOffset) li++;
          this.eventIndex = li;
          this.port.postMessage({ type: 'looped' });
          return this.chip.renderSample();
        } else {
          this.ended = true;
          this.playing = false;
          this.port.postMessage({ type: 'ended' });
        }
      }
      this.eventIndex++;
    }
    const sample = this.chip.renderSample();
    this.currentSample++;
    return sample;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const outRate = sampleRate; // global AudioWorklet sampleRate
    const ratio = this.vgmRate / outRate;

    for (let i = 0; i < left.length; i++) {
      if (!this.playing || this.ended) {
        left[i] = 0;
        if (right !== left) right[i] = 0;
        continue;
      }
      // Simple rate conversion: advance internal clock by `ratio` vgm-samples per output sample.
      this.outAccumPos += ratio;
      let s = this.lastL;
      while (this.outAccumPos >= 1) {
        s = this._advanceOneVgmSample();
        this.outAccumPos -= 1;
        if (this.ended) break;
      }
      this.lastL = s;
      const clipped = Math.max(-1, Math.min(1, s));
      left[i] = clipped;
      if (right !== left) right[i] = clipped;
    }

    // Report position periodically
    if (this._posCounter === undefined) this._posCounter = 0;
    this._posCounter += left.length;
    if (this._posCounter > 4096) {
      this._posCounter = 0;
      this.port.postMessage({ type: 'position', sample: this.currentSample, total: this.totalSamples });
    }

    return true;
  }
}

registerProcessor('vgm-player-processor', VGMPlayerProcessor);