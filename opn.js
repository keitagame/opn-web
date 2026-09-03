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
    this.loopSampleOffset = -1;
    this.adpcmRam = null;
    this._parse();
  }

  _readU32(off) { return this.view.getUint32(off, true); }
  _readU16(off) { return this.view.getUint16(off, true); }
  _readU8(off) { return this.view.getUint8(off); }

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
    h.ym2608Clock = 0;
    h.dataOffset = 0x40;

    if (h.version >= 0x101) {
      h.rate = this._readU32(0x24);
    }
    if (h.version >= 0x151) {
      const dataOff = this._readU32(0x34);
      h.dataOffset = dataOff !== 0 ? dataOff + 0x34 : 0x40;
    }
    if (this.buf.length > 0x48 && h.version >= 0x151) {
      h.ym2203Clock = this._readU32(0x44);
      h.ym2608Clock = this._readU32(0x48);
    }

    this.totalSamples = h.totalSamples;
    this.loopByteOffset = h.loopOffset ? h.loopOffset + 0x1c : -1;

    if (h.gd3Offset) {
      this._parseGD3(h.gd3Offset + 0x14);
    }

    this._parseCommands();
  }

  _parseGD3(off) {
    try {
      if (this._magic(off) !== 'Gd3 ') return;
      let p = off + 12;
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

      if (cmd === 0x66) {
        this.events.push({ sampleOffset, type: 'end' });
        break;
      } else if (cmd === 0x55) {
        const addr = buf[p + 1];
        const data = buf[p + 2];
        this.events.push({ sampleOffset, type: 'ym2203', addr, data });
        p += 3;
      } else if (cmd === 0x61) {
        const n = this._readU16(p + 1);
        sampleOffset += n;
        p += 3;
      } else if (cmd === 0x52 || cmd === 0x53 || cmd === 0x56 || cmd === 0x57) {
        const port = (cmd === 0x53 || cmd === 0x57) ? 1 : 0;
        const addr = buf[p + 1];
        const data = buf[p + 2];
        this.events.push({ sampleOffset, type: 'ym2608', port, addr, data });
        p += 3;
      } else if (cmd === 0x62) {
        sampleOffset += 735;
        p += 1;
      } else if (cmd === 0x63) {
        sampleOffset += 882;
        p += 1;
      } else if (cmd >= 0x70 && cmd <= 0x7f) {
        sampleOffset += (cmd & 0x0f) + 1;
        p += 1;
      } else if (cmd >= 0x80 && cmd <= 0x8f) {
        sampleOffset += (cmd & 0x0f);
        p += 1;
      } else if (cmd === 0x67) { // Data block (ADPCM RAM)
        const dataType = buf[p + 2];
        const size = this._readU32(p + 3);
        if (dataType === 0x81 || dataType === 0x01) {
          const startAddr = this._readU32(p + 7);
          const dataSlice = buf.subarray(p + 11, p + 7 + size);
          if (!this.adpcmRam) this.adpcmRam = new Uint8Array(256 * 1024);
          this.adpcmRam.set(dataSlice, startAddr);
        }
        p += 7 + size;
      } else if (cmd === 0x50 || cmd >= 0x30 && cmd <= 0x3f) {
        p += 2;
      } else if (cmd === 0x54 || (cmd >= 0x40 && cmd <= 0x4e) || (cmd >= 0x5a && cmd <= 0x5f) || cmd === 0xa0) {
        p += 3;
      } else if (cmd >= 0x90 && cmd <= 0x95) {
        if (cmd === 0x90 || cmd === 0x91 || cmd === 0x95) p += 5;
        else if (cmd === 0x92) p += 6;
        else if (cmd === 0x93) p += 11;
        else if (cmd === 0x94) p += 2;
      } else if (cmd === 0xe0) {
        p += 5;
      } else {
        this.events.push({ sampleOffset, type: 'end' });
        break;
      }
    }

    if (this.events.length === 0 || this.events[this.events.length - 1].type !== 'end') {
      this.events.push({ sampleOffset, type: 'end' });
    }
  }
}

// ---------- Shared tables & DSP ----------

const SIN_BITS = 10;
const SIN_LEN = 1 << SIN_BITS;
const SIN_TABLE = new Float64Array(SIN_LEN);
for (let i = 0; i < SIN_LEN; i++) {
  SIN_TABLE[i] = Math.sin((i / SIN_LEN) * Math.PI * 2);
}

function rateToStep(rate) {
  if (rate <= 0) return 0;
  const r = Math.min(63, rate);
  return Math.pow(2, r / 4) * 0.00005;
}

class FMOperator {
  constructor() {
    this.phase = 0;
    this.freq = 0;
    this.mul = 1;
    this.det = 0;
    this.tl = 127;
    this.ar = 31;
    this.dr = 0;
    this.sr = 0;
    this.rr = 15;
    this.sl = 0;
    this.ks = 0;
    this.ssgeg = 0;
    this.out = 0;
    this.out2 = 0;
    this.envState = 'idle';
    this.envLevel = 1023;
    this.keyOn = false;
    this.blockFnum = 0;
  }

  setKeyOn(on) {
    if (on && !this.keyOn) {
      this.envState = 'attack';
    } else if (!on && this.keyOn) {
      this.envState = 'release';
    }
    this.keyOn = on;
  }

  effRate(rate, isRelease = false) {
    if (rate === 0) return 0;
    const ks = this.ks;
    const rks = this.blockFnum >> (3 - ks);
    let r = isRelease ? (rate * 2 + 1 + rks) : (rate * 2 + rks);
    if (r > 63) r = 63;
    if (r < 0) r = 0;
    return r;
  }

  advanceEnvelope() {
    const ATTACK_TAB = 1.6;
    switch (this.envState) {
      case 'attack': {
        const r = this.effRate(this.ar);
        if (r === 0) break;
        if (this.ar === 31) {
          this.envLevel = 0;
          this.envState = 'decay';
          break;
        }
        const step = Math.pow(2, r / 8) * ATTACK_TAB;
        this.envLevel -= (this.envLevel * (step / 1000)) + 0.15;
        if (this.envLevel <= 0) {
          this.envLevel = 0;
          this.envState = 'decay';
        }
        break;
      }
      case 'decay': {
        const r = this.effRate(this.dr);
        const step = rateToStep(r);
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
          const step = rateToStep(r);
          this.envLevel += step;
        }
        break;
      }
      case 'release': {
        const r = this.effRate(this.rr, true);
        const step = rateToStep(r);
        this.envLevel += step;
        break;
      }
    }
    if (this.envLevel > 1023) this.envLevel = 1023;
    if (this.envLevel < 0) this.envLevel = 0;
  }

  getSample(modInput) {
    const tlAtten = this.tl * 8;
    const totalAtten = Math.min(1023, tlAtten + this.envLevel);
    const amp = Math.pow(10, -totalAtten / (1023 / 3));

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

class FMChannel {
  constructor() {
    this.ops = [new FMOperator(), new FMOperator(), new FMOperator(), new FMOperator()];
    this.algorithm = 0;
    this.feedback = 0;
    this.block = 4;
    this.fnum = 0;
    this.panLeft = true;
    this.panRight = true;
  }

  setFNumBlock(fnum, block) {
    this.fnum = fnum;
    this.block = block;
    for (const op of this.ops) op.blockFnum = (block << 3) | (fnum >> 7 & 0x7);
  }

  updateOperatorFreqs(sampleRate, clock) {
    const baseFreq = (this.fnum * clock) / (144 * Math.pow(2, 20 - this.block));
    const fnumHi = (this.fnum >> 7) & 0x0f;
    const noteCode = FNUM_TO_NOTE_CODE[fnumHi];
    const keyCode = Math.min(31, (this.block << 2) | noteCode);

    for (const op of this.ops) {
      const mul = op.mul === 0 ? 0.5 : op.mul;
      const detMag = op.det & 0x03;
      const isNegative = (op.det & 0x04) !== 0;
      const detRaw = DETUNE_TABLE[keyCode][detMag];
      const detSign = isNegative ? -detRaw : detRaw;

      const detuneHz = (detSign * clock) / (144 * Math.pow(2, 20 - this.block));
      const f = baseFreq * mul + detuneHz;
      op.freq = (f / sampleRate) * SIN_LEN;
    }
  }

  render() {
    const [op1, op2, op3, op4] = this.ops;
    const fbShift = this.feedback > 0 ? (10 - this.feedback) : 16;
    const fbMod = this.feedback > 0 ? ((op1.out + op1.out2) * SIN_LEN) / Math.pow(2, fbShift) : 0;
    const MOD_SCALE = SIN_LEN * 2.0;

    let out1, out2, out3, out4, chOut;

    switch (this.algorithm) {
      case 0:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * MOD_SCALE);
        out3 = op3.getSample(out2 * MOD_SCALE);
        out4 = op4.getSample(out3 * MOD_SCALE);
        chOut = out4;
        break;
      case 1:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(0);
        out3 = op3.getSample((out1 + out2) * MOD_SCALE);
        out4 = op4.getSample(out3 * MOD_SCALE);
        chOut = out4;
        break;
      case 2:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(0);
        out3 = op3.getSample((out1 + out2) * MOD_SCALE);
        out4 = op4.getSample(out3 * MOD_SCALE);
        chOut = out4;
        break;
      case 3:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * MOD_SCALE);
        out3 = op3.getSample(0);
        out4 = op4.getSample((out2 + out3) * MOD_SCALE);
        chOut = out4;
        break;
      case 4:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * MOD_SCALE);
        out3 = op3.getSample(0);
        out4 = op4.getSample(out3 * MOD_SCALE);
        chOut = out2 + out4;
        break;
      case 5:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * MOD_SCALE);
        out3 = op3.getSample(out1 * MOD_SCALE);
        out4 = op4.getSample(out1 * MOD_SCALE);
        chOut = op2 + out3 + out4;
        break;
      case 6:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(out1 * MOD_SCALE);
        out3 = op3.getSample(0);
        out4 = op4.getSample(0);
        chOut = out2 + out3 + out4;
        break;
      case 7:
      default:
        out1 = op1.getSample(fbMod);
        out2 = op2.getSample(0);
        out3 = op3.getSample(0);
        out4 = op4.getSample(0);
        chOut = out1 + out2 + out3 + out4;
        break;
    }

    op1.step(op1.freq);
    op2.step(op2.freq);
    op3.step(op3.freq);
    op4.step(op4.freq);

    return chOut;
  }
}

class SSG {
  constructor(sampleRate, clock) {
    this.sampleRate = sampleRate;
    this.clock = clock || 1500000;
    this.regs = new Uint8Array(16);
    this.toneCounter = [0, 0, 0];
    this.tonePos = [0, 0, 0];
    this.noiseCounter = 0;
    this.noiseShift = 1;
    this.envCounter = 0;
    this.envPos = 0;
    this.envHold = false;
    this.envAtten = 0;
  }

  writeReg(addr, value) {
    if (addr < 16) this.regs[addr] = value;
    if (addr === 13) {
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
          if (!cont) this.envHold = true;
        }
      }
    }
    const shapeBit = this.regs[13] & 0x0f;
    let pos = this.envPos;
    const cont = (shapeBit & 0x08) !== 0;
    const attackDir = (shapeBit & 0x04) !== 0;
    const alt = (shapeBit & 0x02) !== 0;
    const hold = (shapeBit & 0x01) !== 0;

    let level;
    if (!cont) {
      level = attackDir ? Math.max(0, 15 - pos) : Math.max(0, 15 - pos);
      if (pos >= 15) level = attackDir ? 15 : 0;
      if (hold && pos >= 15) level = attackDir ? 0 : 0;
    } else {
      const cyclePos = pos % 16;
      const cycleNum = Math.floor(pos / 16);
      let rising = attackDir;
      if (alt && (cycleNum % 2 === 1)) rising = !rising;
      level = rising ? cyclePos : (15 - cyclePos);
      if (hold && pos >= 16 && !alt) level = attackDir ? 15 : 0;
    }
    this.envAtten = Math.max(0, Math.min(15, level));
  }

  render() {
    const toneStepDivisor = 4;
    for (let ch = 0; ch < 3; ch++) {
      const period = this.getTonePeriod(ch);
      this.toneCounter[ch] += this.clock / toneStepDivisor / this.sampleRate;
      if (this.toneCounter[ch] >= period) {
        this.toneCounter[ch] -= period;
        this.tonePos[ch] ^= 1;
      }
    }

    const noisePeriod = this.getNoisePeriod();
    this.noiseCounter += this.clock / toneStepDivisor / this.sampleRate;
    if (this.noiseCounter >= noisePeriod) {
      this.noiseCounter -= noisePeriod;
      const bit = ((this.noiseShift ^ (this.noiseShift >> 3)) & 1);
      this.noiseShift = (this.noiseShift >> 1) | (bit << 16);
    }
    const noiseOut = this.noiseShift & 1;

    this.stepEnvelope();

    let mono = 0;
    const mixer = this.mixerByte();

    for (let ch = 0; ch < 3; ch++) {
      const toneDisabled = (mixer >> ch) & 1;
      const noiseDisabled = (mixer >> (ch + 3)) & 1;
      
      const toneVal = toneDisabled ? 1 : this.tonePos[ch];
      const noiseVal = noiseDisabled ? 1 : noiseOut;
      const active = toneVal & noiseVal;

      const volReg = this.volReg(ch);
      const useEnv = (volReg & 0x10) !== 0;
      let vol = useEnv ? this.envAtten : (volReg & 0x0f);

      if (active) {
        mono += SSG_VOL_TABLE[vol];
      }
    }

    return mono;
  }
}

// ---------- YM2608 特有機能（リズム音源 & ADPCM） ----------

class YM2608Rhythm {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.regs = new Uint8Array(0x20);
    this.buffers = [];
    this.positions = [0, 0, 0, 0, 0, 0];
    this.active = [false, false, false, false, false, false];
    this._generateSamples();
  }

  _generateSamples() {
    const sr = 16000;
    
    // 0: BD
    const bdLen = Math.floor(sr * 0.18);
    const bd = new Float32Array(bdLen);
    let bdPhase = 0;
    for (let i = 0; i < bdLen; i++) {
      const t = i / sr;
      const freq = 140 * Math.exp(-t * 30) + 35;
      bdPhase += (freq / sr) * Math.PI * 2;
      bd[i] = Math.sin(bdPhase) * Math.exp(-t * 22) * 1.2;
    }
    this.buffers.push(bd);

    // 1: SD
    const sdLen = Math.floor(sr * 0.18);
    const sd = new Float32Array(sdLen);
    let sdPhase = 0;
    for (let i = 0; i < sdLen; i++) {
      const t = i / sr;
      const freq = 220 * Math.exp(-t * 25) + 80;
      sdPhase += (freq / sr) * Math.PI * 2;
      const tone = Math.sin(sdPhase) * Math.exp(-t * 28);
      const noise = (Math.random() * 2 - 1) * Math.exp(-t * 18);
      sd[i] = (tone * 0.5 + noise * 0.7);
    }
    this.buffers.push(sd);

    // 2: TC
    const tcLen = Math.floor(sr * 0.4);
    const tc = new Float32Array(tcLen);
    for (let i = 0; i < tcLen; i++) {
      const t = i / sr;
      const n1 = Math.sin(i * 3.14) > 0 ? 1 : -1;
      const n2 = Math.sin(i * 4.37) > 0 ? 1 : -1;
      const n3 = Math.sin(i * 5.82) > 0 ? 1 : -1;
      tc[i] = (n1 + n2 + n3 + (Math.random() * 2 - 1)) * 0.25 * Math.exp(-t * 7);
    }
    this.buffers.push(tc);

    // 3: HH
    const hhLen = Math.floor(sr * 0.06);
    const hh = new Float32Array(hhLen);
    let prevN = 0;
    for (let i = 0; i < hhLen; i++) {
      const t = i / sr;
      const raw = Math.random() * 2 - 1;
      const hp = raw - prevN * 0.6;
      prevN = raw;
      hh[i] = hp * Math.exp(-t * 55) * 0.8;
    }
    this.buffers.push(hh);

    // 4: TOM
    const tomLen = Math.floor(sr * 0.16);
    const tom = new Float32Array(tomLen);
    let tomPhase = 0;
    for (let i = 0; i < tomLen; i++) {
      const t = i / sr;
      const freq = 180 * Math.exp(-t * 20) + 60;
      tomPhase += (freq / sr) * Math.PI * 2;
      tom[i] = Math.sin(tomPhase) * Math.exp(-t * 18) * 1.1;
    }
    this.buffers.push(tom);

    // 5: RIM
    const rimLen = Math.floor(sr * 0.05);
    const rim = new Float32Array(rimLen);
    let rimPhase = 0;
    for (let i = 0; i < rimLen; i++) {
      const t = i / sr;
      rimPhase += (850 / sr) * Math.PI * 2;
      const tone = Math.sin(rimPhase);
      const click = i < 10 ? (Math.random() * 2 - 1) : 0;
      rim[i] = (tone * 0.6 + click * 0.8) * Math.exp(-t * 80);
    }
    this.buffers.push(rim);
  }

  write(addr, data) {
    if (addr < 0x20) this.regs[addr] = data;
    if (addr === 0x10) {
      if (data & 0x80) {
        for (let i = 0; i < 6; i++) this.active[i] = false;
      } else {
        for (let i = 0; i < 6; i++) {
          if ((data & (1 << i)) !== 0) {
            this.positions[i] = 0;
            this.active[i] = true;
          }
        }
      }
    }
  }

  render() {
    const totalVolReg = this.regs[0x11] & 0x3f;
    const totalVol = Math.pow(10, -(totalVolReg * 0.75) / 20);

    let sumL = 0, sumR = 0;
    const stepRatio = 16000 / this.sampleRate;

    for (let i = 0; i < 6; i++) {
      if (!this.active[i]) continue;
      const buf = this.buffers[i];
      const pos = Math.floor(this.positions[i]);
      if (pos >= buf.length) {
        this.active[i] = false;
        continue;
      }
      const rawSample = buf[pos];
      this.positions[i] += stepRatio;

      const instReg = this.regs[0x18 + i];
      const panL = (instReg & 0x80) !== 0 || instReg === 0;
      const panR = (instReg & 0x40) !== 0 || instReg === 0;
      const instVol = instReg & 0x1f;
      const vol = Math.pow(10, -((31 - instVol) * 1.0) / 20) * totalVol;

      const s = rawSample * vol;
      if (panL) sumL += s;
      if (panR) sumR += s;
    }
    return [sumL, sumR];
  }
}

const ADPCM_STEPS = [
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253,
  279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552
];

const ADPCM_INDEX_ADJ = [-1, -1, -1, -1, 2, 4, 6, 8];

class YM2608ADPCM {
  constructor(sampleRate, clock) {
    this.sampleRate = sampleRate;
    this.clock = clock || 7987200;
    this.ram = null;
    this.regs = new Uint8Array(0x20);

    this.playing = false;
    this.startAddr = 0;
    this.stopAddr = 0;
    this.nibblePos = 0;
    this.valpred = 0;
    this.stepIndex = 0;
    this.phase = 0;
    this.lastSample = 0;
  }

  setRam(ramBuffer) {
    this.ram = ramBuffer;
  }

  write(addr, data) {
    if (addr < 0x20) this.regs[addr] = data;
    if (addr === 0x00) {
      if (data & 0x80) {
        this.startAddr = (((this.regs[0x03] << 8) | this.regs[0x02])) << 3;
        this.stopAddr = ((((this.regs[0x05] << 8) | this.regs[0x04]) + 1)) << 3;
        this.nibblePos = this.startAddr * 2;
        this.valpred = 0;
        this.stepIndex = 0;
        this.playing = (data & 0x20) !== 0 || (data & 0x80) !== 0;
      }
      if (data & 0x01) {
        this.playing = false;
      }
    }
  }

  _decodeNextNibble() {
    if (!this.ram) return 0;
    const byteAddr = Math.floor(this.nibblePos / 2);
    if (byteAddr >= this.stopAddr || byteAddr >= this.ram.length) {
      this.playing = false;
      return 0;
    }
    const b = this.ram[byteAddr];
    const nibble = (this.nibblePos % 2 === 0) ? ((b >> 4) & 0x0f) : (b & 0x0f);
    this.nibblePos++;

    let step = ADPCM_STEPS[this.stepIndex];
    let diff = step >> 3;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 4) diff += step;
    if (nibble & 8) this.valpred -= diff; else this.valpred += diff;
    if (this.valpred > 32767) this.valpred = 32767;
    if (this.valpred < -32768) this.valpred = -32768;

    this.stepIndex += ADPCM_INDEX_ADJ[nibble & 7];
    if (this.stepIndex < 0) this.stepIndex = 0;
    if (this.stepIndex > 48) this.stepIndex = 48;

    return this.valpred / 32768.0;
  }

  render() {
    if (!this.playing || !this.ram) return [0, 0];

    const deltaN = (this.regs[0x0a] << 8) | this.regs[0x09];
    const adpcmClock = (deltaN / 65536.0) * 16000.0;
    const stepRatio = adpcmClock / this.sampleRate;

    this.phase += stepRatio;
    while (this.phase >= 1.0) {
      this.phase -= 1.0;
      this.lastSample = this._decodeNextNibble();
      if (!this.playing) break;
    }

    const panReg = this.regs[0x01];
    const panL = (panReg & 0x80) !== 0 || panReg === 0;
    const panR = (panReg & 0x40) !== 0 || panReg === 0;
    const level = (this.regs[0x0b] || 255) / 255.0;

    const s = this.lastSample * level;
    return [panL ? s : 0, panR ? s : 0];
  }
}

const OP_ORDER = [0, 2, 1, 3];

class YM2608 {
  constructor(sampleRate, clock) {
    this.sampleRate = sampleRate;
    this.clock = clock || 7987200;
    this.channels = Array.from({ length: 6 }, () => new FMChannel());
    this.ssg = new SSG(sampleRate, this.clock / 4);
    this.rhythm = new YM2608Rhythm(sampleRate);
    this.adpcm = new YM2608ADPCM(sampleRate, this.clock);
  }

  setAdpcmRam(ram) {
    this.adpcm.setRam(ram);
  }

  write(port, addr, data) {
    addr &= 0xff;
    data &= 0xff;

    // Rhythm (Port 0, 0x10 - 0x1D)
    if (port === 0 && addr >= 0x10 && addr <= 0x1d) {
      this.rhythm.write(addr, data);
      return;
    }

    // SSG (Port 0, 0x00 - 0x0F)
    if (port === 0 && addr < 0x10) {
      this.ssg.writeReg(addr, data);
      return;
    }

    // ADPCM (Port 1, 0x00 - 0x10)
    if (port === 1 && addr <= 0x10) {
      this.adpcm.write(addr, data);
      return;
    }

    // FM Key On / Off (Port 0, 0x28)
    if (port === 0 && addr === 0x28) {
      const chBits = data & 0x07;
      if ((chBits & 0x03) === 3) return;
      const ch = (chBits & 0x04 ? 3 : 0) + (chBits & 0x03);
      const opMask = (data >> 4) & 0x0f;
      const channel = this.channels[ch];
      for (let i = 0; i < 4; i++) {
        channel.ops[i].setKeyOn((opMask & (1 << i)) !== 0);
      }
      return;
    }

    // FM Operator parameters
    if (addr >= 0x30 && addr < 0xa0) {
      const opSelGroup = addr & 0x03;
      if (opSelGroup > 2) return;
      const chSel = opSelGroup + (port * 3);
      const opSel = (addr >> 2) & 0x03;
      const regGroup = addr & 0xf0;
      const channel = this.channels[chSel];
      const op = channel.ops[OP_ORDER[opSel]];

      switch (regGroup) {
        case 0x30: op.mul = data & 0x0f; op.det = (data >> 4) & 0x07; this._updateFreq(channel); break;
        case 0x40: op.tl = data & 0x7f; break;
        case 0x50: op.ks = (data >> 6) & 0x03; op.ar = data & 0x1f; break;
        case 0x60: op.dr = data & 0x1f; break;
        case 0x70: op.sr = data & 0x1f; break;
        case 0x80: op.sl = (data >> 4) & 0x0f; op.rr = data & 0x0f; break;
        case 0x90: op.ssgeg = data & 0x0f; break;
      }
      return;
    }

    const chBase = port * 3;
    switch (addr) {
      case 0xa0: case 0xa1: case 0xa2: {
        const ch = (addr - 0xa0) + chBase;
        this._pendingFnumLo = this._pendingFnumLo || {};
        this._pendingFnumLo[ch] = data;
        this._applyFreq(ch);
        break;
      }
      case 0xa4: case 0xa5: case 0xa6: {
        const ch = (addr - 0xa4) + chBase;
        this._pendingFnumHi = this._pendingFnumHi || {};
        this._pendingFnumHi[ch] = data;
        this._applyFreq(ch);
        break;
      }
      case 0xb0: case 0xb1: case 0xb2: {
        const ch = (addr - 0xb0) + chBase;
        const channel = this.channels[ch];
        channel.algorithm = data & 0x07;
        channel.feedback = (data >> 3) & 0x07;
        break;
      }
      case 0xb4: case 0xb5: case 0xb6: {
        const ch = (addr - 0xb4) + chBase;
        const channel = this.channels[ch];
        channel.panLeft = (data & 0x80) !== 0;
        channel.panRight = (data & 0x40) !== 0;
        break;
      }
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

  renderSample() {
    let fmOutL = 0;
    let fmOutR = 0;
    for (const ch of this.channels) {
      const s = ch.render();
      if (ch.panLeft) fmOutL += s;
      if (ch.panRight) fmOutR += s;
    }

    const ssgOut = this.ssg.render() * 0.8;
    const [rhythmL, rhythmR] = this.rhythm.render();
    const [adpcmL, adpcmR] = this.adpcm.render();

    const mixL = fmOutL * 0.5 + ssgOut + rhythmL * 0.6 + adpcmL * 0.6;
    const mixR = fmOutR * 0.5 + ssgOut + rhythmR * 0.6 + adpcmR * 0.6;

    return [
      Math.max(-1, Math.min(1, mixL)),
      Math.max(-1, Math.min(1, mixR))
    ];
  }
}

const YM2203 = YM2608;

// ---------- メインスレッド用 VGM プレイヤークラス (AudioWorklet 非使用) ----------

class VGMPlayer {
  constructor(audioCtx, vgmSampleRate = 44100) {
    this.audioCtx = audioCtx;
    this.vgmRate = vgmSampleRate;
    this.chip = new YM2608(this.vgmRate, 7987200);
    this.events = [];
    this.eventIndex = 0;
    this.totalSamples = 0;
    this.loopSampleOffset = -1;
    this.currentSample = 0;
    this.playing = false;
    this.loopEnabled = true;
    this.ended = false;

    this.outAccumPos = 0;
    this.lastL = 0;
    this.lastR = 0;
    this._posCounter = 0;

    this.onPosition = null;
    this.onEnded = null;
    this.onLooped = null;

    this.node = this.audioCtx.createScriptProcessor(4096, 0, 2);
    this.node.onaudioprocess = (e) => this._process(e);
  }

  connect(destination) {
    this.node.connect(destination);
  }

  disconnect() {
    this.node.disconnect();
  }

  load(vgmParser) {
    this.events = vgmParser.events;
    this.totalSamples = vgmParser.totalSamples;
    this.loopSampleOffset = vgmParser.loopSampleOffset;
    this.eventIndex = 0;
    this.currentSample = 0;
    
    const h = vgmParser.header;
    const clock = h.ym2608Clock || h.ym2203Clock || 7987200;
    this.chip = new YM2608(this.vgmRate, clock);
    if (vgmParser.adpcmRam) {
      this.chip.setAdpcmRam(vgmParser.adpcmRam);
    }
    this.ended = false;
    this.playing = false;
  }

  play() {
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  stop() {
    this.playing = false;
    this.currentSample = 0;
    this.eventIndex = 0;
    this.chip = new YM2608(this.vgmRate, this.chip.clock);
  }

  seekSample(targetSample) {
    this.chip = new YM2608(this.vgmRate, this.chip.clock);
    let i = 0;
    while (i < this.events.length && this.events[i].sampleOffset <= targetSample) {
      const ev = this.events[i];
      if (ev.type === 'ym2203') {
        this.chip.write(0, ev.addr, ev.data);
      } else if (ev.type === 'ym2608') {
        this.chip.write(ev.port, ev.addr, ev.data);
      }
      i++;
    }
    this.eventIndex = i;
    this.currentSample = targetSample;
  }

  setLoop(enabled) {
    this.loopEnabled = enabled;
  }

  _advanceOneVgmSample() {
    while (this.eventIndex < this.events.length && this.events[this.eventIndex].sampleOffset <= this.currentSample) {
      const ev = this.events[this.eventIndex];
      if (ev.type === 'ym2203') {
        this.chip.write(0, ev.addr, ev.data);
      } else if (ev.type === 'ym2608') {
        this.chip.write(ev.port, ev.addr, ev.data);
      } else if (ev.type === 'end') {
        if (this.loopEnabled && this.loopSampleOffset >= 0) {
          this.currentSample = this.loopSampleOffset;
          let li = 0;
          while (li < this.events.length && this.events[li].sampleOffset < this.loopSampleOffset) li++;
          this.eventIndex = li;
          if (this.onLooped) this.onLooped();
          return this.chip.renderSample();
        } else {
          this.ended = true;
          this.playing = false;
          if (this.onEnded) this.onEnded();
        }
      }
      this.eventIndex++;
    }
    const sample = this.chip.renderSample();
    this.currentSample++;
    return sample;
  }

  _process(e) {
    const left = e.outputBuffer.getChannelData(0);
    const right = e.outputBuffer.getChannelData(1);
    const outRate = this.audioCtx.sampleRate;
    const ratio = this.vgmRate / outRate;

    for (let i = 0; i < left.length; i++) {
      if (!this.playing || this.ended) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }

      this.outAccumPos += ratio;
      let [sL, sR] = [this.lastL, this.lastR];
      while (this.outAccumPos >= 1) {
        const res = this._advanceOneVgmSample();
        if (Array.isArray(res)) {
          [sL, sR] = res;
        } else {
          sL = sR = res;
        }
        this.outAccumPos -= 1;
        if (this.ended) break;
      }
      this.lastL = sL;
      this.lastR = sR;

      left[i] = Math.max(-1, Math.min(1, sL));
      right[i] = Math.max(-1, Math.min(1, sR));
    }

    this._posCounter += left.length;
    if (this._posCounter > 4096) {
      this._posCounter = 0;
      if (this.onPosition) {
        this.onPosition({ sample: this.currentSample, total: this.totalSamples });
      }
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { VGMParser, YM2203, YM2608, VGMPlayer };
}