
'use strict';
const SSG_VOL_TABLE = [
  0.0000, 0.0047, 0.0069, 0.0101, 0.0147, 0.0218, 0.0319, 0.0467,
  0.0684, 0.1004, 0.1472, 0.2159, 0.3168, 0.4650, 0.6815, 1.0000
];
// 実機OPN仕様のデチューンテーブル (キーコード 0~31 × 強度 0~3)
const DETUNE_TABLE = [
  [0, 0, 1, 2], [0, 0, 1, 2], [0, 0, 1, 2], [0, 0, 1, 2],
  [0, 0, 1, 2], [0, 1, 1, 2], [0, 1, 1, 2], [0, 1, 2, 3],
  [0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 4], [0, 1, 3, 4],
  [0, 1, 3, 4], [0, 1, 3, 5], [0, 2, 4, 5], [0, 2, 4, 6],
  [0, 2, 4, 6], [0, 2, 5, 7], [0, 2, 5, 8], [0, 3, 6, 8],
  [0, 3, 6, 9], [0, 3, 7, 10], [0, 4, 8, 11], [0, 4, 8, 12],
  [0, 4, 9, 13], [0, 5, 10, 14], [0, 5, 11, 16], [0, 6, 12, 17],
  [0, 6, 13, 19], [0, 7, 14, 20], [0, 8, 16, 22], [0, 9, 17, 24]
];

// F-Numberの上位4ビットからノート区分(0~3)を引く変換表
const FNUM_TO_NOTE_CODE = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3];
class VGMParser {
  constructor(arrayBuffer) {
    this.buf = new Uint8Array(arrayBuffer);
    this.view = new DataView(arrayBuffer);
    this.header = {};
    this.gd3 = null;
    this.events = []; // { sampleOffset, type, ...data }
    this.totalSamples = 0;
    this.loopSampleOffset = -1; // sample index where loop begins, -1 if none
    this._parse();
  }

  _readU32(off) { return this.view.getUint32(off, true); }
  _readU16(off) { return this.view.getUint16(off, true); }
  _readU8(off) { return this.view.getUint8(off); }
  _readI32(off) { return this.view.getInt32(off, true); }

  _magic(off) {
    return String.fromCharCode(this.buf[off], this.buf[off + 1], this.buf[off + 2], this.buf[off + 3]);
  }

  _parse() {
    if (this._magic(0) !== 'Vgm ') {
      throw new Error('VGMファイルではありません (シグネチャ不一致)');
    }
    const h = this.header;
    h.eofOffset = this._readU32(0x04);
    h.version = this._readU32(0x08);
    h.sn76489Clock = this._readU32(0x0c);
    h.ym2413Clock = this._readU32(0x10);
    h.gd3Offset = this._readU32(0x14);
    h.totalSamples = this._readU32(0x18);
    h.loopOffset = this._readU32(0x1c);
    h.loopSamples = this._readU32(0x20);

    h.ym2203Clock = 0;
    h.dataOffset = 0x40; // default for older versions

    if (h.version >= 0x101) {
      h.rate = this._readU32(0x24);
    }
    if (h.version >= 0x110) {
      // more clocks...
    }
    if (h.version >= 0x151) {
      const dataOff = this._readU32(0x34);
      h.dataOffset = dataOff !== 0 ? dataOff + 0x34 : 0x40;
    }
    if (h.version >= 0x151 && h.version < 0x161) {
      // ym2203 clock at 0x44 introduced in 1.51
    }
    if (this.buf.length > 0x48 && h.version >= 0x151) {
      h.ym2203Clock = this._readU32(0x44);
      h.ym2608Clock = this._readU32(0x48);
    }
    if (this.buf.length > 0x4c && h.version >= 0x151) {
      h.ym2610Clock = this._readU32(0x4c);
    }

    // Fallback: some tools write YM2203 clock even in headers we didn't fully map;
    // scan common offsets defensively.
    if (!h.ym2203Clock && this.buf.length > 0x44) {
      const maybe = this._readU32(0x44);
      if (maybe > 100000 && maybe < 10000000) h.ym2203Clock = maybe;
    }

    this.totalSamples = h.totalSamples;
    if (h.loopOffset) {
      this.loopByteOffset = h.loopOffset + 0x1c;
    } else {
      this.loopByteOffset = -1;
    }

    if (h.gd3Offset) {
      this._parseGD3(h.gd3Offset + 0x14);
    }

    this._parseCommands();
  }

  _parseGD3(off) {
    try {
      if (this._magic(off) !== 'Gd3 ') return;
      let p = off + 12; // skip magic(4)+version(4)+length(4)
      const strs = [];
      let cur = [];
      while (p < this.buf.length - 1) {
        const code = this._readU16(p);
        p += 2;
        if (code === 0) {
          strs.push(cur.join(''));
          cur = [];
          if (strs.length >= 11) break;
        } else {
          cur.push(String.fromCharCode(code));
        }
      }
      this.gd3 = {
        trackNameEn: strs[0] || '',
        trackNameJp: strs[1] || '',
        gameNameEn: strs[2] || '',
        gameNameJp: strs[3] || '',
        systemNameEn: strs[4] || '',
        systemNameJp: strs[5] || '',
        authorEn: strs[6] || '',
        authorJp: strs[7] || '',
        releaseDate: strs[8] || '',
        vgmBy: strs[9] || '',
        notes: strs[10] || '',
      };
    } catch (e) {
      this.gd3 = null;
    }
  }

  _parseCommands() {
    const buf = this.buf;
    let p = this.header.dataOffset;
    const end = this.header.gd3Offset ? Math.min(buf.length, this.header.gd3Offset + 0x14) : buf.length;
    let sampleOffset = 0;
    const loopStartByte = this.loopByteOffset;

    while (p < end && p < buf.length) {
      const cmd = buf[p];

      if (loopStartByte >= 0 && p === loopStartByte) {
        this.loopSampleOffset = sampleOffset;
      }

      if (cmd === 0x66) { // end of sound data
        this.events.push({ sampleOffset, type: 'end' });
        break;
      } else if (cmd === 0x55) {
        // 0x55 aa dd: YM2203 write, port implied single addr space
        const addr = buf[p + 1];
        const data = buf[p + 2];
        this.events.push({ sampleOffset, type: 'ym2203', addr, data });
        p += 3;
      } else if (cmd === 0x61) {
        // wait n samples (16-bit)
        const n = this._readU16(p + 1);
        sampleOffset += n;
        p += 3;
      } else if (cmd === 0x62) {
        sampleOffset += 735; // 1/60s wait
        p += 1;
      } else if (cmd === 0x63) {
        sampleOffset += 882; // 1/50s wait
        p += 1;
      } else if (cmd >= 0x70 && cmd <= 0x7f) {
        // wait 0-15 samples
        sampleOffset += (cmd & 0x0f) + 1;
        p += 1;
      } else if (cmd >= 0x80 && cmd <= 0x8f) {
        // YM2612 port0 addr2A write + wait n samples (n = cmd-0x80) - not used for 2203, skip data byte handling
        sampleOffset += (cmd & 0x0f);
        p += 1;
      } else if (cmd === 0x50) {
        // PSG (SN76489) write - skip, not YM2203
        p += 2;
      } else if (cmd === 0x54) {
        // YM2151 write
        p += 3;
      } else if (cmd === 0x56 || cmd === 0x57) {
        // YM2413 / others
        p += 3;
      } else if (cmd === 0x5a || cmd === 0x5b || cmd === 0x5c || cmd === 0x5d || cmd === 0x5e || cmd === 0x5f) {
        p += 3;
      } else if (cmd === 0xa0) {
        // AY8910 write
        p += 3;
      } else if (cmd === 0x67) {
        // data block
        const type = buf[p + 2];
        const size = this._readU32(p + 3);
        p += 7 + size;
      } else if (cmd === 0x90 || cmd === 0x91 || cmd === 0x92 || cmd === 0x93 || cmd === 0x94 || cmd === 0x95) {
        // DAC stream control - variable length, handle minimal known sizes
        if (cmd === 0x90) p += 5;
        else if (cmd === 0x91) p += 5;
        else if (cmd === 0x92) p += 6;
        else if (cmd === 0x93) p += 11;
        else if (cmd === 0x94) p += 2;
        else if (cmd === 0x95) p += 5;
      } else if (cmd === 0xe0) {
        // seek to offset in PCM data bank
        p += 5;
      } else if (cmd >= 0x30 && cmd <= 0x3f) {
        p += 2;
      } else if (cmd >= 0x40 && cmd <= 0x4e) {
        p += 3;
      } else {
        // Unknown command: try to guess length conservatively; abort to avoid corrupting parse.
        // Most single/double-arg commands fall in ranges above; if truly unknown, stop.
        this.events.push({ sampleOffset, type: 'end' });
        break;
      }
    }

    if (this.events.length === 0 || this.events[this.events.length - 1].type !== 'end') {
      this.events.push({ sampleOffset, type: 'end' });
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { VGMParser };
}

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
function rateToStep(rate) {
  if (rate <= 0) return 0;
  const r = Math.min(63, rate);
  return Math.pow(2, r / 4) * 0.00005; // 0.00035 から縮小
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
  const step = rateToStep(r); // * 40 を除去
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
    const step = rateToStep(r); // * 40 を除去
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
  const tlAtten = this.tl * 8;
  const totalAtten = Math.min(1023, tlAtten + this.envLevel);
  const amp = Math.pow(10, -totalAtten / (1023 / 3));

  // ビット演算 & による小数切り捨てを防ぐため Math.floor を使用
  let ph = Math.floor(this.phase + modInput) % SIN_LEN;
  if (ph < 0) ph += SIN_LEN;
  
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
// 修正後
updateOperatorFreqs(sampleRate, clock) {
    const baseFreq = (this.fnum * clock) / (144 * Math.pow(2, 20 - this.block));
    
    // F-NumberとBlockからキーコード (0..31) を算出
    const fnumHi = (this.fnum >> 7) & 0x0f;
    const noteCode = FNUM_TO_NOTE_CODE[fnumHi];
    const keyCode = Math.min(31, (this.block << 2) | noteCode);

    for (const op of this.ops) {
      const mul = op.mul === 0 ? 0.5 : op.mul;
      
      // デチューン値の取得 (ビット2が符号、ビット0-1が強度)
      const detMag = op.det & 0x03;
      const isNegative = (op.det & 0x04) !== 0;
      const detRaw = DETUNE_TABLE[keyCode][detMag];
      const detSign = isNegative ? -detRaw : detRaw;

      // オクターブ(Block)にスケールを合わせたデチューン周波数(Hz)
      const detuneHz = (detSign * clock) / (144 * Math.pow(2, 20 - this.block));

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

    const MOD_SCALE = SIN_LEN * 2.0;

  let out1, out2, out3, out4, chOut;

  switch (this.algorithm) {
    case 0: // op1 -> op2 -> op3 -> op4
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(out1 * MOD_SCALE);
      out3 = op3.getSample(out2 * MOD_SCALE);
      out4 = op4.getSample(out3 * MOD_SCALE);
      chOut = out4;
      break;
    case 1: // (op1 + op2) -> op3 -> op4
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(0);
      out3 = op3.getSample((out1 + out2) * MOD_SCALE);
      out4 = op4.getSample(out3 * MOD_SCALE);
      chOut = out4;
      break;
    case 2: // (op1 & op2) -> op3 -> op4
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(0);
      out3 = op3.getSample((out1 + out2) * MOD_SCALE);
      out4 = op4.getSample(out3 * MOD_SCALE);
      chOut = out4;
      break;
    case 3: // op1->op2->op4, op3->op4
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(out1 * MOD_SCALE);
      out3 = op3.getSample(0);
      out4 = op4.getSample((out2 + out3) * MOD_SCALE);
      chOut = out4;
      break;
    case 4: // op1->op2, op3->op4
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(out1 * MOD_SCALE);
      out3 = op3.getSample(0);
      out4 = op4.getSample(out3 * MOD_SCALE);
      chOut = out2 + out4;
      break;
    case 5: // op1 -> (op2, op3, op4)
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(out1 * MOD_SCALE);
      out3 = op3.getSample(out1 * MOD_SCALE);
      out4 = op4.getSample(out1 * MOD_SCALE);
      chOut = out2 + out3 + out4;
      break;
    case 6: // op1->op2, op3, op4
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(out1 * MOD_SCALE);
      out3 = op3.getSample(0);
      out4 = op4.getSample(0);
      chOut = out2 + out3 + out4;
      break;
    case 7: // 並列
    default:
      out1 = op1.getSample(fbMod);
      out2 = op2.getSample(0);
      out3 = op3.getSample(0);
      out4 = op4.getSample(0);
      chOut = out1 + out2 + out3 + out4; // op3.out, op4.out ではなく out3, out4 を使用
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
    const toneStepDivisor = 4; // AY divides clock by 16 for the tone counters' clock
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
      mono += SSG_VOL_TABLE[vol] * 0.2; // 実機準拠テーブルを使用
    }
  
    }
    
    // Sum (not average) the three channels so a single active channel still
    // reaches a strong amplitude; overall headroom is managed by the tanh
    // limiter in YM2203.renderSample.
    return mono;
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
  const ch = data & 0x03;
  if (ch > 2) return;
  const opMask = (data >> 4) & 0x0f;
  const channel = this.channels[ch];
  
  // マスクされたオペレータのみをON/OFF制御する
  for (let i = 0; i < 4; i++) {
    if (opMask & (1 << i)) {
      channel.ops[i].setKeyOn(true);
    } else {
      channel.ops[i].setKeyOn(false);
    }
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
      const regGroup = addr & 0xf0;
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

    const mix = fmOut * 0.5 + ssgOut * 0.5;
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