/*
 * YM2203 (OPN) Emulator in JavaScript
 * - 4 channel FM synthesis (4-operator, 8 algorithms)
 * - 3 channel SSG (AY-3-8910 compatible square wave + noise + envelope)
 *
 * This is a from-scratch, compact software implementation intended for
 * VGM playback. It follows the well-documented OPN register map and
 * standard FM synthesis math (phase accumulation, sine table, envelope
 * generator with attack/decay/sustain/release + SSG-EG style rates).
 */

'use strict';

// ---------- Shared tables ----------

// Standard YM2203/OPN sine table (10-bit output values, log-domain not used here;
// we use a direct sine LUT for speed, with the classic 256-entry quarter... using
// full 1024-entry table via Math.sin for simplicity & correctness in JS).
const SIN_BITS = 10;
const SIN_LEN = 1 << SIN_BITS; // 1024
const SIN_TABLE = new Float64Array(SIN_LEN);
for (let i = 0; i < SIN_LEN; i++) {
  SIN_TABLE[i] = Math.sin((i / SIN_LEN) * Math.PI * 2);
}

// Envelope generator rate tables (simplified OPN-style exponential-ish curve)
// We implement ADSR in the "attenuation" domain (0 = full volume, 1023 = silence)
// using standard OPN rate-to-increment approximation.
function rateToStep(rate, keyScale) {
  // rate: 0-63 (after key scaling), returns attenuation increment per sample-ish tick
  if (rate <= 0) return 0;
  const r = Math.min(63, rate);
  return Math.pow(2, r / 4) * 0.00035;
}

// ---------- FM Operator ----------

class FMOperator {
  constructor() {
    this.phase = 0;         // current phase accumulator (0..SIN_LEN)
    this.freq = 0;          // phase increment per sample
    this.mul = 1;           // multiple
    this.det = 0;           // detune
    this.tl = 127;          // total level (0=loud .. 127=silent)
    this.ar = 31;           // attack rate
    this.dr = 0;            // decay rate
    this.sr = 0;            // sustain rate
    this.rr = 15;           // release rate
    this.sl = 0;            // sustain level
    this.ks = 0;            // key scale
    this.ssgeg = 0;         // SSG-EG mode (0 = off)
    this.out = 0;           // last output sample (for feedback)
    this.out2 = 0;

    // envelope state
    this.envState = 'idle'; // attack, decay, sustain, release, idle
    this.envLevel = 1023;   // attenuation, 1023 = silence, 0 = full
    this.keyOn = false;
    this.blockFnum = 0;     // for key scaling rate
  }

  setKeyOn(on) {
    if (on && !this.keyOn) {
      this.envState = 'attack';
      // envelope does not fully reset phase in real hardware unless configured,
      // but for simplicity and click-free sound we keep phase continuous.
    } else if (!on && this.keyOn) {
      this.envState = 'release';
    }
    this.keyOn = on;
  }

  // Compute effective rate with key scaling
  effRate(rate) {
    if (rate === 0) return 0;
    const ks = this.ks; // 0..3
    const rks = this.blockFnum >> (3 - ks);
    let r = rate * 2 + rks;
    if (r > 63) r = 63;
    if (r < 0) r = 0;
    return r;
  }

  advanceEnvelope() {
    const ATTACK_TAB = 1.6; // tuning constants for speed of envelope segments
    switch (this.envState) {
      case 'attack': {
        const r = this.effRate(this.ar);
        if (r === 0) { break; }
        if (this.ar === 31) {
          this.envLevel = 0;
          this.envState = 'decay';
          break;
        }
        const step = Math.pow(2, r / 8) * ATTACK_TAB;
        // attack reduces attenuation (envLevel) toward 0, exponential-ish
        this.envLevel -= (this.envLevel * (step / 1000)) + 0.15;
        if (this.envLevel <= 0) {
          this.envLevel = 0;
          this.envState = 'decay';
        }
        break;
      }
      case 'decay': {
        const r = this.effRate(this.dr);
        const step = rateToStep(r) * 40;
        this.envLevel += step;
        const slLevel = this.sl >= 15 ? 1023 : this.sl * 64;
        if (this.envLevel >= slLevel) {
          this.envLevel = slLevel;
          this.envState = 'sustain';
        }
        break;
      }
      case 'sustain': {
        const r = this.effRate(this.sr);
        if (r > 0) {
          const step = rateToStep(r) * 40;
          this.envLevel += step;
        }
        break;
      }
      case 'release': {
        const r = this.effRate(this.rr * 2 + 1);
        const step = rateToStep(r) * 40;
        this.envLevel += step;
        break;
      }
      default:
        break;
    }
    if (this.envLevel > 1023) this.envLevel = 1023;
    if (this.envLevel < 0) this.envLevel = 0;
  }

  // Get current output given modulation input (phase modulation, in radians*scale)
  getSample(modInput) {
    const tlAtten = this.tl * 8; // TL 0..127 -> 0..1016 attenuation units
    const totalAtten = Math.min(1023, tlAtten + this.envLevel);
    const amp = Math.pow(10, -totalAtten / (1023 / 3)); // ~3 decades dynamic range

    let ph = (this.phase + modInput) & (SIN_LEN - 1);
    ph = ((ph % SIN_LEN) + SIN_LEN) % SIN_LEN;
    const s = SIN_TABLE[ph] * amp;
    this.out2 = this.out;
    this.out = s;
    return s;
  }

  step(phaseInc) {
    this.phase = (this.phase + phaseInc) % SIN_LEN;
    this.advanceEnvelope();
  }
}

// ---------- FM Channel (4 operators) ----------

const ALGO_CONNECTIONS = 8;

class FMChannel {
  constructor() {
    this.ops = [new FMOperator(), new FMOperator(), new FMOperator(), new FMOperator()];
    this.algorithm = 0;
    this.feedback = 0;
    this.block = 4;
    this.fnum = 0;
    this.freqBase = 0; // phase increment base for op mul=1
    this.pan = 3; // 1=left 2=right 3=both (OPN doesn't have pan on FM but keep for mixer symmetry)
  }

  setFNumBlock(fnum, block) {
    this.fnum = fnum;
    this.block = block;
    for (const op of this.ops) op.blockFnum = (block << 3) | (fnum >> 7 & 0x7); // rough key-scale code approx
  }

  updateOperatorFreqs(sampleRate, clock) {
    // OPN frequency formula: Fnum/Block -> operator frequency
    // f = (Fnum * clock) / (144 * 2^(20-Block)) roughly (approximation used widely)
    const baseFreq = (this.fnum * clock) / (144 * Math.pow(2, 20 - this.block));
    for (const op of this.ops) {
      const detuneHz = DETUNE_TABLE[op.det] ? DETUNE_TABLE[op.det][this.block] || 0 : 0;
      const mul = op.mul === 0 ? 0.5 : op.mul;
      const f = baseFreq * mul + detuneHz;
      op.freq = (f / sampleRate) * SIN_LEN;
    }
  }

  keyOn(opMask) {
    for (let i = 0; i < 4; i++) {
      if (opMask & (1 << i)) this.ops[i].setKeyOn(true);
    }
  }
  keyOff(opMask) {
    for (let i = 0; i < 4; i++) {
      if (opMask & (1 << i)) this.ops[i].setKeyOn(false);
    }
  }

  render() {
    const [op1, op2, op3, op4] = this.ops;
    const fbShift = this.feedback > 0 ? (10 - this.feedback) : 16;
    const fbMod = this.feedback > 0 ? ((op1.out + op1.out2) * SIN_LEN) / Math.pow(2, fbShift) : 0;

    let out1, out2, out3, out4, chOut;

    switch (this.algorithm) {
      case 0: // op1->op2->op3->op4 (series)
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * SIN_LEN * 0.5);
        out3 = op3.getSample(out2 * SIN_LEN * 0.5);
        out4 = op4.getSample(out3 * SIN_LEN * 0.5);
        chOut = out4;
        break;
      case 1: // (op1+op2)->op3->op4
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(0);
        out3 = op3.getSample((out1 + out2) * SIN_LEN * 0.5);
        out4 = op4.getSample(out3 * SIN_LEN * 0.5);
        chOut = out4;
        break;
      case 2: // op1 -> op3, (op2 -> op3) -> op4  (op1 & op2 both feed op3)
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(0);
        out3 = op3.getSample((out1 + out2) * SIN_LEN * 0.5);
        out4 = op4.getSample(out3 * SIN_LEN * 0.5);
        chOut = out4;
        break;
      case 3: // op1->op2->op4, op3->op4
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * SIN_LEN * 0.5);
        out3 = op3.getSample(0);
        out4 = op4.getSample((out2 + out3) * SIN_LEN * 0.5);
        chOut = out4;
        break;
      case 4: // op1->op2 (out), op3->op4 (out)
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * SIN_LEN * 0.5);
        out3 = op3.getSample(0);
        out4 = op4.getSample(out3 * SIN_LEN * 0.5);
        chOut = (out2 + out4) * 0.5;
        break;
      case 5: // op1 feeds op2,op3,op4 in parallel
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * SIN_LEN * 0.5);
        out3 = op3.getSample(out1 * SIN_LEN * 0.5);
        out4 = op4.getSample(out1 * SIN_LEN * 0.5);
        chOut = (out2 + out3 + out4) / 3;
        break;
      case 6: // op1->op2 (out), op3 (out), op4 (out)
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * SIN_LEN * 0.5);
        out3 = op3.getSample(0);
        out4 = op4.getSample(0);
        chOut = (out2 + out3 + out4) / 3;
        break;
      case 7: // all parallel (additive)
      default:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(0);
        out3 = op3.getSample(0);
        out4 = op4.getSample(0);
        chOut = (out1 + out2 + out3 + out4) / 4;
        break;
    }

    // advance phases/envelopes for next sample
    op1.step(op1.freq);
    op2.step(op2.freq);
    op3.step(op3.freq);
    op4.step(op4.freq);

    return chOut;
  }
}

// Rough detune table (Hz offsets), simplified from standard OPN detune table by block.
const DETUNE_TABLE = {
  0: [0, 0, 0, 0, 0, 0, 0, 0],
  1: [0, 0, 1, 2, 2, 4, 5, 6],
  2: [0, 1, 2, 2, 4, 5, 6, 8],
  3: [0, 1, 2, 3, 4, 6, 8, 10],
  4: [0, 0, 0, 0, 0, 0, 0, 0],
  5: [0, -1, -2, -2, -4, -5, -6, -8],
  6: [0, -1, -2, -3, -4, -6, -8, -10],
  7: [0, -2, -3, -4, -6, -8, -10, -12],
};

// ---------- SSG (AY-3-8910 compatible, 3 square channels + noise + envelope) ----------

class SSG {
  constructor(sampleRate, clock) {
    this.sampleRate = sampleRate;
    this.clock = clock || 1500000; // typical SSG clock in OPN systems (varies)
    this.regs = new Uint8Array(16);
    this.toneCounter = [0, 0, 0];
    this.tonePos = [0, 0, 0]; // 0 or 1 (square wave state)
    this.noiseCounter = 0;
    this.noiseShift = 1;
    this.envCounter = 0;
    this.envPos = 0;
    this.envHold = false;
    this.envAtten = 0; // 0..15
  }

  writeReg(addr, value) {
    if (addr < 16) this.regs[addr] = value;
    if (addr === 13) { // envelope shape written -> reset envelope
      this.envPos = 0;
      this.envHold = false;
    }
  }

  getTonePeriod(ch) {
    const lo = this.regs[ch * 2];
    const hi = this.regs[ch * 2 + 1] & 0x0f;
    const p = (hi << 8) | lo;
    return p === 0 ? 1 : p;
  }

  getNoisePeriod() {
    const p = this.regs[6] & 0x1f;
    return p === 0 ? 1 : p;
  }

  getEnvPeriod() {
    const lo = this.regs[11];
    const hi = this.regs[12];
    const p = (hi << 8) | lo;
    return p === 0 ? 1 : p;
  }

  mixerByte() { return this.regs[7]; }

  volReg(ch) { return this.regs[8 + ch]; }

  stepEnvelope() {
    // envelope runs at clock/16 ... approximate stepping done per-sample in render
    const shape = this.regs[13] & 0x0f;
    const period = this.getEnvPeriod();
    this.envCounter++;
    if (this.envCounter >= period) {
      this.envCounter = 0;
      if (!this.envHold) {
        this.envPos++;
        if (this.envPos >= 32) {
          this.envPos = 0;
          const cont = (shape & 0x08) !== 0;
          const alt = (shape & 0x02) !== 0;
          const hold = (shape & 0x01) !== 0;
          if (!cont) {
            this.envHold = true;
            this.envAttenFinal = 15;
          } else if (hold) {
            this.envHold = true;
          }
        }
      }
    }
    // compute attenuation 0..15 based on position & shape
    const shapeBit = this.regs[13] & 0x0f;
    let pos = this.envPos;
    const cont = (shapeBit & 0x08) !== 0;
    const attackDir = (shapeBit & 0x04) !== 0;
    const alt = (shapeBit & 0x02) !== 0;
    const hold = (shapeBit & 0x01) !== 0;

    let level;
    if (!cont) {
      // one-shot: decay to 0 (or attack to max then hold at 0) - simplified
      level = attackDir ? Math.max(0, 15 - pos) : Math.max(0, 15 - pos);
      if (pos >= 15) level = attackDir ? 15 : 0;
      if (hold && pos >= 15) level = attackDir ? 0 : 0;
    } else {
      const cyclePos = pos % 16;
      const cycleNum = Math.floor(pos / 16);
      let rising = attackDir;
      if (alt && (cycleNum % 2 === 1)) rising = !rising;
      level = rising ? cyclePos : (15 - cyclePos);
      if (hold && pos >= 16 && !alt) {
        level = attackDir ? 15 : 0;
      }
    }
    this.envAtten = Math.max(0, Math.min(15, level));
  }

  render() {
    // Advance tone generators (simple toggling square wave at clock/16/period)
    const toneStepDivisor = 16; // AY divides clock by 16 for the tone counters' clock
    let left = 0, right = 0, mono = 0;
    const mixer = this.mixerByte();

    for (let ch = 0; ch < 3; ch++) {
      const period = this.getTonePeriod(ch);
      this.toneCounter[ch] += this.clock / toneStepDivisor / this.sampleRate;
      if (this.toneCounter[ch] >= period) {
        this.toneCounter[ch] -= period;
        this.tonePos[ch] ^= 1;
      }
    }

    // noise
    const noisePeriod = this.getNoisePeriod();
    this.noiseCounter += this.clock / toneStepDivisor / this.sampleRate;
    if (this.noiseCounter >= noisePeriod) {
      this.noiseCounter -= noisePeriod;
      // 17-bit LFSR
      const bit = ((this.noiseShift ^ (this.noiseShift >> 3)) & 1);
      this.noiseShift = (this.noiseShift >> 1) | (bit << 16);
    }
    const noiseOut = this.noiseShift & 1;

    this.stepEnvelope();

    for (let ch = 0; ch < 3; ch++) {
      const toneDisabled = (mixer >> ch) & 1;
      const noiseDisabled = (mixer >> (ch + 3)) & 1;
      const toneVal = toneDisabled ? 1 : this.tonePos[ch];
      const noiseVal = noiseDisabled ? 1 : noiseOut;
      const active = toneVal | noiseVal;

      const volReg = this.volReg(ch);
      const useEnv = (volReg & 0x10) !== 0;
      let vol = useEnv ? this.envAtten : (volReg & 0x0f);

      if (active) {
        // convert 0..15 volume to amplitude (roughly logarithmic like real AY)
        const amp = vol === 0 ? 0 : Math.pow(2, (vol - 15) / 2);
        mono += amp;
      }
    }
    // Sum (not average) the three channels so a single active channel still
    // reaches a strong amplitude; overall headroom is managed by the tanh
    // limiter in YM2203.renderSample.
    return mono * 0.5;
  }
}

// ---------- YM2203 top-level chip ----------

const OPN_ALGORITHMS_OPS = 4;

// Standard OPN key-code (block/fnum) table isn't perfectly linear; we use
// an approximation good enough for music-accurate playback of most VGMs.

class YM2203 {
  constructor(sampleRate, clock) {
    this.sampleRate = sampleRate;
    this.clock = clock || 3993600; // common YM2203 clock (varies per system, e.g. 3.99MHz)
    this.channels = [new FMChannel(), new FMChannel(), new FMChannel()];
    this.ssg = new SSG(sampleRate, this.clock / 2); // SSG typically runs at clock/2 in OPN
    this.selectedRegPart0 = 0;
    this.prescaler = 6; // OPN default prescaler divides clock for FM
    this.lastKeyOnReg = 0;
  }

  // VGM YM2203 write: port (0 or 1 unused for 2203, it's single address space
  // but many VGM streams use command 0x55 aa dd) -> we implement write(addr, data)
  write(addr, data) {
    addr &= 0xff;
    data &= 0xff;

    if (addr === 0x28) {
      // Key on/off: data bits: bit2-3 = channel select within group... For YM2203 (3 FM ch):
      // D0-D1: channel (0,1,2), D4-D7: operator key bits
      const ch = data & 0x03;
      if (ch > 2) return; // YM2203 only has channels 0-2 for FM
      const opMask = (data >> 4) & 0x0f;
      const channel = this.channels[ch];
      if (opMask === 0) {
        channel.keyOff(0xf);
      } else {
        channel.keyOn(opMask);
        channel.keyOff((~opMask) & 0xf);
      }
      return;
    }

    if (addr < 0x10) {
      // SSG registers 0x00-0x0F map directly
      this.ssg.writeReg(addr, data);
      return;
    }

    if (addr === 0x2d || addr === 0x2e || addr === 0x2f) {
      // prescaler select, ignore (rare in VGMs)
      return;
    }

    // FM operator registers 0x30-0x9F, channel encoded in low 2 bits (0,1,2; 3=unused for 2203)
    if (addr >= 0x30 && addr < 0xa0) {
      const chSel = addr & 0x03;
      if (chSel > 2) return;
      const opSel = (addr >> 2) & 0x03; // 0..3 operator index within group
      const regGroup = addr & 0xfc;
      const channel = this.channels[chSel];
      const op = channel.ops[OP_ORDER[opSel]];

      switch (regGroup) {
        case 0x30: // DT/MUL
          op.mul = data & 0x0f;
          op.det = (data >> 4) & 0x07;
          this._updateFreq(channel);
          break;
        case 0x40: // TL
          op.tl = data & 0x7f;
          break;
        case 0x50: // KS/AR
          op.ks = (data >> 6) & 0x03;
          op.ar = data & 0x1f;
          break;
        case 0x60: // AM/DR (decay rate) - AM not implemented (LFO), decay only
          op.dr = data & 0x1f;
          break;
        case 0x70: // SR (sustain rate)
          op.sr = data & 0x1f;
          break;
        case 0x80: // SL/RR
          op.sl = (data >> 4) & 0x0f;
          op.rr = data & 0x0f;
          break;
        case 0x90: // SSG-EG
          op.ssgeg = data & 0x0f;
          break;
        default:
          break;
      }
      return;
    }

    switch (addr) {
      case 0x22: // LFO (not implemented, ignore)
        break;
      case 0x24: // Timer A high
      case 0x25: // Timer A low
      case 0x26: // Timer B
      case 0x27: // timer control / ch3 mode
        break;
      case 0xa0: case 0xa1: case 0xa2: { // FNUM low byte (ch0-2), latched with block/fnum-hi
        const ch = addr - 0xa0;
        this._pendingFnumLo = this._pendingFnumLo || {};
        this._pendingFnumLo[ch] = data;
        this._applyFreq(ch);
        break;
      }
      case 0xa4: case 0xa5: case 0xa6: { // Block/FNUM high (ch0-2)
        const ch = addr - 0xa4;
        this._pendingFnumHi = this._pendingFnumHi || {};
        this._pendingFnumHi[ch] = data;
        this._applyFreq(ch);
        break;
      }
      case 0xb0: case 0xb1: case 0xb2: { // Feedback/Algorithm
        const ch = addr - 0xb0;
        const channel = this.channels[ch];
        channel.algorithm = data & 0x07;
        channel.feedback = (data >> 3) & 0x07;
        break;
      }
      default:
        break;
    }
  }

  _applyFreq(ch) {
    const lo = (this._pendingFnumLo && this._pendingFnumLo[ch]) || 0;
    const hiByte = (this._pendingFnumHi && this._pendingFnumHi[ch]) || 0;
    const fnum = ((hiByte & 0x07) << 8) | lo;
    const block = (hiByte >> 3) & 0x07;
    const channel = this.channels[ch];
    channel.setFNumBlock(fnum, block);
    this._updateFreq(channel);
  }

  _updateFreq(channel) {
    channel.updateOperatorFreqs(this.sampleRate, this.clock);
  }

  // Render one mono sample. FM channels are summed (not averaged) since each
  // channel's own algorithm already normalizes its internal operator mix;
  // averaging across channels would incorrectly quiet tracks that use only
  // one or two of the three FM channels. A soft-knee tanh limiter prevents
  // clipping when multiple channels play loudly at once.
  renderSample() {
    let fmOut = 0;
    for (const ch of this.channels) {
      fmOut += ch.render();
    }

    const ssgOut = this.ssg.render();

    const mix = fmOut * 0.5 + ssgOut * 0.45;
    // soft limiter: gentle tanh saturation keeps peaks in range without
    // audibly compressing normal-level passages
    return Math.tanh(mix * 1.15);
  }
}

// Operator register order in OPN: registers at offsets 0,1,2,3 (i.e. +0,+4,+8,+12)
// map to operators in order OP1, OP3, OP2, OP4 (classic OPN quirk).
const OP_ORDER = [0, 2, 1, 3];

if (typeof module !== 'undefined') {
  module.exports = { YM2203 };
}
