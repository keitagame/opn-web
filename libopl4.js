/**
 * OPL4 (YMF278B) Synth & VGM Player Library
 *
 *   FM   : YMF262 (OPL3) 互換 18ch / 4-op / リズムモード / 8波形 (YMF278B内蔵FM部)
 *   PCM  : 24ボイス ウェーブテーブル (ROM/RAM, 8/12/16bit, ループ, EG, LFO, パン)
 *   他   : YMF262 単体 (VGM 0x5E/0x5F) にも対応
 *
 * VGM: 0xD0 (YMF278B), 0x5E/0x5F (YMF262), データブロック 0x84 (ROM) / 0x87 (RAM)
 * ※ PCM音源にはウェーブROM (yrw801.rom 等, 2MB) が必要。
 *    VGM内に埋め込まれていない場合は VGMPlayer.loadRom(arrayBuffer) で渡す。
 *
 * [高音質化・臨場感強化版]
 *   - 出力リサンプラ: 3次補間 → 48タップ Kaiser窓 sinc (帯域制限, エイリアシング除去)
 *   - PCM: 線形補間 → 4点3次補間, 音量の端数補間 + ゲイン平滑化 (ジッパーノイズ除去)
 *   - SpatialFX: 疑似ステレオ拡張 / 初期反射 / 8ライン FDN リバーブ / クロスフィード / ルックアヘッドリミッタ
 *   - 使い方: new VGMPlayer(ctx, 44100, { fxPreset: 'immersive' })
 *             player.setFxPreset('natural' | 'immersive' | 'hall' | 'off')
 *             player.setFx({ width: 1.5, reverb: 0.3 })
 */

// =====================================================================
//  定数 & テーブル
// =====================================================================
const OPL4_CLOCK = 33868800;      // YMF278B マスタークロック (→ 44.1kHz)
const OPL3_CLOCK = 14318180;      // YMF262 クロック (→ 49716Hz)
const MEM_SIZE = 0x400000;        // 4MB (ROM: 0-0x1FFFFF / RAM: 0x200000-0x3FFFFF)
const MEM_MASK = MEM_SIZE - 1;
const RAM_BASE = 0x200000;

const FM_GAIN = 1.6 / 32768;      // FM 1ch 最大 ≒ 0.2
const PCM_GAIN = 0.5 / 32768;     // PCM 1voice 最大 ≒ 0.5

// 対数サイン表 / 指数表 (OPL と同じ 1/256 oct 単位)
const SIN_ATT = new Uint16Array(256);
const POW_TAB = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  SIN_ATT[i] = Math.round(-Math.log2(Math.sin(((2 * i + 1) * Math.PI) / 1024)) * 256);
  POW_TAB[i] = Math.round((Math.pow(2, (255 - i) / 256) - 1) * 1024);
}

function expOut(att) {
  if (att > 0x1fff) att = 0x1fff;
  return ((POW_TAB[att & 0xff] + 1024) << 1) >> (att >> 8);
}

const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0];
const MULT2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
const SLOT_MAP = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17, -1, -1];

// レート → 1サンプルあたりの変化量 (OPL3実測の時間特性から)
const RATE_DEC = new Float64Array(64);   // 減衰: 9bit(0.1875dB)単位/sample
const RATE_ATK = new Float64Array(64);   // 立ち上がり: 指数係数/sample
for (let r = 1; r < 64; r++) {
  const m = Math.pow(2, (r >> 2) - 1) * (1 + (r & 3) / 4);
  RATE_DEC[r] = 2.6217e-4 * m;
  RATE_ATK[r] = Math.min(0.9, 4.438e-5 * m);
}

// PCM 用 (1/64oct = 0.094dB 単位, 0〜1023)
const AMP_TAB = new Float64Array(2048);
for (let i = 0; i < 2048; i++) AMP_TAB[i] = i >= 1023 ? 0 : Math.pow(2, -i / 64);
function ampOf(att) {
  // 端数を線形補間 (整数化による音量の階段状変化 = ジッパーノイズを防ぐ)
  if (att < 0) att = 0;
  if (att >= 1022) return 0;
  const i = att | 0, f = att - i;
  return AMP_TAB[i] + (AMP_TAB[i + 1] - AMP_TAB[i]) * f;
}
const PAN_L = [0, 8, 16, 24, 32, 40, 48, 256, 256, 0, 0, 0, 0, 0, 0, 0];
const PAN_R = [0, 0, 0, 0, 0, 0, 0, 0, 256, 256, 48, 40, 32, 24, 16, 8];
const LFO_HZ = [0.168, 2.019, 3.196, 4.206, 5.215, 5.888, 6.224, 7.066];
const VIB_CENTS = [0, 3.378, 5.065, 6.750, 10.114, 20.170, 40.106, 79.307];
const AM_UNITS = [0, 1.781, 2.906, 3.656, 4.406, 5.406, 6.406, 7.406].map(db => db / 0.09375);
const MIX_GAIN = [];
for (let i = 0; i < 8; i++) MIX_GAIN.push(i >= 7 ? 0 : Math.pow(10, -3 * i / 20));

// =====================================================================
//  ヘルパー
// =====================================================================
function cubic(a, b, c, d, t) {
  return 0.5 * ((2 * b) + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
}

function softOut(x) {
  const T = 0.85;
  if (x > T) return T + (1 - T) * Math.tanh((x - T) / (1 - T));
  if (x < -T) return -T - (1 - T) * Math.tanh((-x - T) / (1 - T));
  return x;
}

// =====================================================================
//  OPL3 (YMF262) FM コア
// =====================================================================
class OplSlot {
  constructor() {
    this.ch = null;
    this.mult = 0; this.ksr = 0; this.egt = 0; this.vib = 0; this.am = 0;
    this.tl = 0; this.kslReg = 0; this.kslAtt = 0;
    this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0; this.wf = 0;
    this.phase = 0; this.pout = 0;
    this.att = 511; this.state = 3; this.keys = 0;
    this.egOut = 511;
    this.out = 0; this.prev = 0;
  }
}

class OplChan {
  constructor(num) {
    this.num = num;
    this.fnum = 0; this.block = 0; this.kcode = 0;
    this.cha = 0; this.chb = 0; this.fb = 0; this.cnt = 0;
    this.slots = [null, null];
  }
}

function opWave(wf, p, eg) {
  p &= 0x3ff;
  let att = 0, neg = false, q;
  switch (wf) {
    case 0:
      neg = (p & 0x200) !== 0; q = p & 0xff; if (p & 0x100) q ^= 0xff; att = SIN_ATT[q]; break;
    case 1:
      if (p & 0x200) return 0;
      q = p & 0xff; if (p & 0x100) q ^= 0xff; att = SIN_ATT[q]; break;
    case 2:
      q = p & 0xff; if (p & 0x100) q ^= 0xff; att = SIN_ATT[q]; break;
    case 3:
      if (p & 0x100) return 0;
      att = SIN_ATT[p & 0xff]; break;
    case 4: {
      if (p & 0x200) return 0;
      const p2 = (p << 1) & 0x3ff;
      neg = (p2 & 0x200) !== 0; q = p2 & 0xff; if (p2 & 0x100) q ^= 0xff; att = SIN_ATT[q]; break;
    }
    case 5: {
      if (p & 0x200) return 0;
      const p2 = (p << 1) & 0x3ff;
      q = p2 & 0xff; if (p2 & 0x100) q ^= 0xff; att = SIN_ATT[q]; break;
    }
    case 6:
      neg = (p & 0x200) !== 0; att = 0; break;
    default:
      neg = (p & 0x200) !== 0; q = p & 0x1ff; if (neg) q ^= 0x1ff; att = q << 3; break;
  }
  const v = expOut(att + (eg << 3));
  return neg ? -v : v;
}

class OPL3Core {
  constructor() {
    this.slots = Array.from({ length: 36 }, () => new OplSlot());
    this.chans = Array.from({ length: 18 }, (_, i) => new OplChan(i));
    for (let c = 0; c < 18; c++) {
      const bank = c >= 9 ? 1 : 0, w = c % 9;
      const base = bank * 18 + ((w / 3) | 0) * 6 + (w % 3);
      const ch = this.chans[c];
      ch.slots = [this.slots[base], this.slots[base + 3]];
      ch.slots[0].ch = ch; ch.slots[1].ch = ch;
    }
    this.newm = false;
    this.fourop = 0;
    this.nts = false;
    this.deepAm = false; this.deepVib = false;
    this.rhythm = false;
    this.timer = 0; this.tremPos = 0; this.vibPos = 0; this.tremolo = 0;
    this.noise = 1;
    this.outL = 0; this.outR = 0;
  }

  // ---- 4-op 判定 ----
  _isLower4(c) {
    if (!this.newm) return false;
    if (c < 3) return ((this.fourop >> c) & 1) === 1;
    if (c >= 9 && c < 12) return ((this.fourop >> (c - 6)) & 1) === 1;
    return false;
  }
  _isUpper4(c) {
    if (!this.newm) return false;
    if (c >= 3 && c < 6) return ((this.fourop >> (c - 3)) & 1) === 1;
    if (c >= 12 && c < 15) return ((this.fourop >> (c - 9)) & 1) === 1;
    return false;
  }

  // ---- キー制御 ----
  _keyOn(s, flag) {
    const was = s.keys;
    s.keys |= flag;
    if (!was) { s.state = 0; s.phase = 0; }
  }
  _keyOff(s, flag) {
    const was = s.keys;
    s.keys &= ~flag;
    if (was && !s.keys) s.state = 3;
  }

  _updateFreq(ch) {
    ch.kcode = (ch.block << 1) | (this.nts ? (ch.fnum >> 8) & 1 : (ch.fnum >> 9) & 1);
    for (const s of ch.slots) this._updateKsl(s, ch);
  }
  _updateKsl(s, ch) {
    if (!s.kslReg) { s.kslAtt = 0; return; }
    let v = (KSL_ROM[ch.fnum >> 6] << 2) - ((8 - ch.block) << 5);
    if (v < 0) v = 0;
    s.kslAtt = v >> KSL_SHIFT[s.kslReg];
  }

  _setChanKey(c, on) {
    const ch = this.chans[c];
    const f = on ? 1 : 0;
    const apply = (cc) => {
      for (const s of cc.slots) { if (on) this._keyOn(s, 1); else this._keyOff(s, 1); }
    };
    ch.kon = f;
    apply(ch);
    if (this._isLower4(c)) apply(this.chans[c + 3]);
  }

  // ---- レジスタ書き込み ----
  write(bank, reg, data) {
    reg &= 0xff; data &= 0xff;

    if (bank === 1) {
      if (reg === 0x04) { this.fourop = data & 0x3f; return; }
      if (reg === 0x05) { this.newm = (data & 1) !== 0; return; }
    } else {
      if (reg === 0x08) {
        this.nts = (data & 0x40) !== 0;
        for (const ch of this.chans) this._updateFreq(ch);
        return;
      }
      if (reg === 0xbd) { this._writeBD(data); return; }
    }
    if (bank === 1 && !this.newm) return;

    if (reg >= 0xa0 && reg <= 0xc8) {
      const g = reg & 0xf0, n = reg & 0x0f;
      if (n > 8) return;
      const c = bank * 9 + n;
      const ch = this.chans[c];
      if (g === 0xa0) {
        if (this._isUpper4(c)) return;
        ch.fnum = (ch.fnum & 0x300) | data;
        this._updateFreq(ch);
        if (this._isLower4(c)) this._copyFreq(ch, this.chans[c + 3]);
      } else if (g === 0xb0) {
        if (this._isUpper4(c)) return;
        ch.fnum = (ch.fnum & 0xff) | ((data & 3) << 8);
        ch.block = (data >> 2) & 7;
        this._updateFreq(ch);
        if (this._isLower4(c)) this._copyFreq(ch, this.chans[c + 3]);
        this._setChanKey(c, (data & 0x20) !== 0);
      } else {
        ch.cha = (data >> 4) & 1;
        ch.chb = (data >> 5) & 1;
        ch.fb = (data >> 1) & 7;
        ch.cnt = data & 1;
      }
      return;
    }

    if ((reg >= 0x20 && reg <= 0x95) || (reg >= 0xe0 && reg <= 0xf5)) {
      const g = reg & 0xe0, o = reg & 0x1f;
      const si = SLOT_MAP[o];
      if (si < 0 || o > 0x15) return;
      const s = this.slots[bank * 18 + si];
      switch (g) {
        case 0x20:
          s.am = (data >> 7) & 1; s.vib = (data >> 6) & 1; s.egt = (data >> 5) & 1;
          s.ksr = (data >> 4) & 1; s.mult = data & 15;
          break;
        case 0x40:
          s.kslReg = data >> 6; s.tl = data & 63;
          this._updateKsl(s, s.ch);
          break;
        case 0x60: s.ar = data >> 4; s.dr = data & 15; break;
        case 0x80: s.sl = (data >> 4) === 15 ? 31 : (data >> 4); s.rr = data & 15; break;
        case 0xe0: s.wf = data & (this.newm ? 7 : 3); break;
        default: break;
      }
    }
  }

  _copyFreq(src, dst) {
    dst.fnum = src.fnum; dst.block = src.block;
    this._updateFreq(dst);
  }

  _writeBD(data) {
    this.deepAm = (data & 0x80) !== 0;
    this.deepVib = (data & 0x40) !== 0;
    const r = (data & 0x20) !== 0;
    const S = this.slots;
    if (r !== this.rhythm) {
      this.rhythm = r;
      if (!r) for (const i of [12, 13, 14, 15, 16, 17]) this._keyOff(S[i], 2);
    }
    if (r) {
      const set = (idx, on) => { if (on) this._keyOn(S[idx], 2); else this._keyOff(S[idx], 2); };
      set(12, data & 0x10); set(15, data & 0x10);   // BD
      set(16, data & 0x08);                         // SD
      set(14, data & 0x04);                         // TOM
      set(17, data & 0x02);                         // TC
      set(13, data & 0x01);                         // HH
    }
  }

  // ---- EG & 位相 ----
  _rate(s, reg) {
    if (!reg) return 0;
    const r = (reg << 2) + (s.ch.kcode >> (s.ksr ? 0 : 2));
    return r > 63 ? 63 : r;
  }

  _advance(s) {
    let att = s.att;
    const st = s.state;
    if (st === 0) {
      const r = this._rate(s, s.ar);
      if (r > 0) {
        if ((r >> 2) >= 15) att = 0;
        else { att -= att * RATE_ATK[r]; if (att < 0.4) att = 0; }
      }
      if (att <= 0) { att = 0; s.state = 1; }
    } else if (st === 1) {
      att += RATE_DEC[this._rate(s, s.dr)];
      const sl = s.sl << 4;
      if (att >= sl) { att = sl; s.state = 2; }
    } else if (st === 2) {
      if (!s.egt) att += RATE_DEC[this._rate(s, s.rr)];
    } else {
      att += RATE_DEC[this._rate(s, s.rr)];
    }
    if (att > 511) att = 511;
    s.att = att;

    // 位相
    const ch = s.ch;
    let fn = ch.fnum;
    if (s.vib) {
      let range = (fn >> 7) & 7;
      const vp = this.vibPos;
      if (!(vp & 3)) range = 0;
      else if (vp & 1) range >>= 1;
      if (!this.deepVib) range >>= 1;
      if (vp & 4) range = -range;
      fn += range;
    }
    s.phase = (s.phase + ((((fn << ch.block) >> 1) * MULT2[s.mult]) >> 1)) & 0x7ffff;
    s.pout = s.phase >>> 9;

    let eg = (att | 0) + (s.tl << 2) + s.kslAtt + (s.am ? this.tremolo : 0);
    s.egOut = eg > 511 ? 511 : eg;
  }

  _wave(s, mod) {
    if (s.egOut >= 496) return 0;
    return opWave(s.wf, s.pout + mod, s.egOut);
  }

  _calc2op(ch) {
    const m = ch.slots[0], c = ch.slots[1];
    const fbm = ch.fb ? (m.out + m.prev) >> (9 - ch.fb) : 0;
    m.prev = m.out;
    m.out = this._wave(m, fbm);
    if (ch.cnt) { c.out = this._wave(c, 0); return m.out + c.out; }
    c.out = this._wave(c, m.out >> 1);
    return c.out;
  }

  _calc4op(L, U) {
    const m1 = L.slots[0], c1 = L.slots[1], m2 = U.slots[0], c2 = U.slots[1];
    const fbm = L.fb ? (m1.out + m1.prev) >> (9 - L.fb) : 0;
    m1.prev = m1.out;
    m1.out = this._wave(m1, fbm);
    switch ((L.cnt << 1) | U.cnt) {
      case 0:
        c1.out = this._wave(c1, m1.out >> 1);
        m2.out = this._wave(m2, c1.out >> 1);
        c2.out = this._wave(c2, m2.out >> 1);
        return c2.out;
      case 1:
        c1.out = this._wave(c1, m1.out >> 1);
        m2.out = this._wave(m2, 0);
        c2.out = this._wave(c2, m2.out >> 1);
        return c1.out + c2.out;
      case 2:
        c1.out = this._wave(c1, 0);
        m2.out = this._wave(m2, c1.out >> 1);
        c2.out = this._wave(c2, m2.out >> 1);
        return m1.out + c2.out;
      default:
        c1.out = this._wave(c1, 0);
        m2.out = this._wave(m2, c1.out >> 1);
        c2.out = this._wave(c2, 0);
        return m1.out + m2.out + c2.out;
    }
  }

  generate() {
    // LFO / ノイズ
    this.timer = (this.timer + 1) | 0;
    if ((this.timer & 63) === 0) { if (++this.tremPos >= 210) this.tremPos = 0; }
    const tp = this.tremPos < 105 ? this.tremPos : 210 - this.tremPos;
    this.tremolo = tp >> (this.deepAm ? 2 : 4);
    if ((this.timer & 1023) === 0) this.vibPos = (this.vibPos + 1) & 7;
    if (this.noise & 1) this.noise ^= 0x800302;
    this.noise >>>= 1;

    const S = this.slots;
    for (let i = 0; i < 36; i++) this._advance(S[i]);

    if (this.rhythm) {
      const s13 = S[13], s16 = S[16], s17 = S[17];
      const hh2 = (s13.pout >> 2) & 1, hh3 = (s13.pout >> 3) & 1;
      const hh7 = (s13.pout >> 7) & 1, hh8 = (s13.pout >> 8) & 1;
      const tc3 = (s17.pout >> 3) & 1, tc5 = (s17.pout >> 5) & 1;
      const x = ((hh2 ^ hh7) | (hh3 ^ tc5) | (tc3 ^ tc5)) & 1;
      const nz = this.noise & 1;
      s13.pout = (x << 9) | ((x ^ nz) ? 0xd0 : 0x34);
      s16.pout = (hh8 << 9) | ((hh8 ^ nz) << 8);
      s17.pout = (x << 9) | 0x80;
    }

    let L = 0, R = 0;
    const nch = this.newm ? 18 : 9;
    for (let c = 0; c < nch; c++) {
      const ch = this.chans[c];
      let o;
      if (this._isUpper4(c)) continue;
      if (this._isLower4(c)) {
        o = this._calc4op(ch, this.chans[c + 3]);
      } else if (this.rhythm && c === 7) {
        const hh = ch.slots[0], sd = ch.slots[1];
        hh.out = this._wave(hh, 0); sd.out = this._wave(sd, 0);
        o = (hh.out + sd.out) << 1;
      } else if (this.rhythm && c === 8) {
        const tom = ch.slots[0], tc = ch.slots[1];
        tom.out = this._wave(tom, 0); tc.out = this._wave(tc, 0);
        o = (tom.out + tc.out) << 1;
      } else {
        o = this._calc2op(ch);
      }
      if (this.newm) {
        if (ch.cha) L += o;
        if (ch.chb) R += o;
      } else { L += o; R += o; }
    }
    this.outL = L; this.outR = R;
  }
}

// =====================================================================
//  OPL4 PCM (ウェーブテーブル) コア
// =====================================================================
class PcmVoice {
  constructor() {
    this.wave = 0; this.fn = 0; this.oct = 0; this.prvb = 0;
    this.tl = 0; this.tlCur = 0; this.ld = 1;
    this.key = false; this.damp = false; this.pan = 0;
    this.lfo = 0; this.vib = 0; this.am = 0;
    this.ar = 0; this.d1r = 0; this.dl = 0; this.d2r = 0; this.rc = 0; this.rr = 0;
    this.fmt = 0; this.start = 0; this.loop = 0; this.end = 0x10000;
    this.pos = 0; this.att = 1023; this.state = 3; this.active = false;
    this.lfoPh = 0; this.baseInc = 1;
    this.gL = 0; this.gR = 0;      // 平滑化済みゲイン
  }
}

class PcmCore {
  constructor(mem, rate) {
    this.mem = mem;
    this.rate = rate;
    this.v = Array.from({ length: 24 }, () => new PcmVoice());
    this.hdrSel = 0;
    this.memAddr = 0;
    this.outL = 0; this.outR = 0;
  }

  _geom(v) {
    const m = this.mem;
    let base;
    if (v.wave < 384 || this.hdrSel === 0) base = v.wave * 12;
    else base = this.hdrSel * 0x80000 + (v.wave - 384) * 12;
    base &= MEM_MASK;
    const b = (i) => m[(base + i) & MEM_MASK];
    v.fmt = b(0) >> 6;
    v.start = ((b(0) & 0x3f) << 16) | (b(1) << 8) | b(2);
    v.loop = (b(3) << 8) | b(4);
    v.end = (((~((b(5) << 8) | b(6))) & 0xffff) + 1);
    return { b, base };
  }

  _loadHeader(v) {
    const { b } = this._geom(v);
    v.lfo = (b(7) >> 3) & 7; v.vib = b(7) & 7;
    v.ar = b(8) >> 4; v.d1r = b(8) & 15;
    v.dl = b(9) >> 4; v.d2r = b(9) & 15;
    v.rc = b(10) >> 4; v.rr = b(10) & 15;
    v.am = b(11) & 7;
  }

  _calcInc(v) {
    v.baseInc = Math.pow(2, v.oct) * (1 + v.fn / 1024);
  }

  write(reg, data) {
    data &= 0xff;
    if (reg === 0x02) { this.hdrSel = (data >> 2) & 7; return; }
    if (reg === 0x03) { this.memAddr = (this.memAddr & 0x00ffff) | ((data & 0x3f) << 16); return; }
    if (reg === 0x04) { this.memAddr = (this.memAddr & 0x3f00ff) | (data << 8); return; }
    if (reg === 0x05) { this.memAddr = (this.memAddr & 0x3fff00) | data; return; }
    if (reg === 0x06) {
      if (this.memAddr >= RAM_BASE && this.memAddr < MEM_SIZE) this.mem[this.memAddr] = data;
      this.memAddr = (this.memAddr + 1) & MEM_MASK;
      return;
    }
    if (reg < 0x08 || reg > 0xf7) return;

    const grp = ((reg - 8) / 24) | 0, n = (reg - 8) % 24;
    const v = this.v[n];
    switch (grp) {
      case 0:
        v.wave = (v.wave & 0x100) | data;
        this._loadHeader(v);
        break;
      case 1: {
        const w = (v.wave & 0xff) | ((data & 1) << 8);
        v.fn = (v.fn & 0x380) | (data >> 1);
        this._calcInc(v);
        if (w !== v.wave) { v.wave = w; this._loadHeader(v); }
        break;
      }
      case 2:
        v.fn = (v.fn & 0x07f) | ((data & 7) << 7);
        v.prvb = (data >> 3) & 1;
        { const o = data >> 4; v.oct = o >= 8 ? o - 16 : o; }
        this._calcInc(v);
        break;
      case 3:
        v.tl = data >> 1; v.ld = data & 1;
        if (v.ld) v.tlCur = v.tl;
        break;
      case 4: {
        const k = (data & 0x80) !== 0;
        v.damp = (data & 0x40) !== 0;
        if (data & 0x20) v.lfoPh = 0;
        v.pan = data & 15;
        if (k && !v.key) {
          if (!v.active) { v.gL = 0; v.gR = 0; }
          this._geom(v);
          v.pos = 0; v.att = 1023; v.state = 0; v.active = true; v.tlCur = v.tl;
        } else if (!k && v.key) {
          v.state = 3;
        }
        v.key = k;
        break;
      }
      case 5: v.lfo = (data >> 3) & 7; v.vib = data & 7; break;
      case 6: v.ar = data >> 4; v.d1r = data & 15; break;
      case 7: v.dl = data >> 4; v.d2r = data & 15; break;
      case 8: v.rc = data >> 4; v.rr = data & 15; break;
      case 9: v.am = data & 7; break;
      default: break;
    }
  }

  _rate(v, reg) {
    if (reg === 0) return 0;
    if (reg === 15) return 63;
    let r = reg << 2;
    if (v.rc !== 15) r += (v.oct + v.rc) * 2 + ((v.fn & 0x200) ? 1 : 0);
    return r < 0 ? 0 : r > 63 ? 63 : r;
  }

  _wrapIdx(v, n) {
    if (n < 0) return 0;
    if (n >= v.end) {
      const span = v.end - v.loop;
      return span > 0 ? v.loop + ((n - v.end) % span) : v.end - 1;
    }
    return n;
  }

  _smp(v, n) {
    const m = this.mem, a = v.start;
    switch (v.fmt) {
      case 0: return ((m[(a + n) & MEM_MASK] << 24) >> 24) << 8;
      case 1: {
        const base = a + (n >> 1) * 3;
        const b1 = m[(base + 1) & MEM_MASK];
        if (n & 1) return (((m[(base + 2) & MEM_MASK] << 8) | ((b1 & 0x0f) << 4)) << 16) >> 16;
        return (((m[base & MEM_MASK] << 8) | (b1 & 0xf0)) << 16) >> 16;
      }
      case 2: {
        const base = a + n * 2;
        return (((m[base & MEM_MASK] << 8) | m[(base + 1) & MEM_MASK]) << 16) >> 16;
      }
      default: return 0;
    }
  }

  generate() {
    let L = 0, R = 0;
    for (let i = 0; i < 24; i++) {
      const v = this.v[i];
      if (!v.active) continue;

      // LFO
      let inc = v.baseInc, amAtt = 0;
      if (v.vib || v.am) {
        v.lfoPh += LFO_HZ[v.lfo] / this.rate;
        if (v.lfoPh >= 1) v.lfoPh -= 1;
        const p = v.lfoPh;
        const tri = p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
        if (v.vib) inc *= Math.pow(2, VIB_CENTS[v.vib] * tri / 1200);
        if (v.am) amAtt = (tri + 1) * 0.5 * AM_UNITS[v.am];
      }

      // エンベロープ
      let att = v.att;
      switch (v.state) {
        case 0: {
          const r = this._rate(v, v.ar);
          if (r > 0) {
            if ((r >> 2) >= 15) att = 0;
            else { att -= att * RATE_ATK[r]; if (att < 0.5) att = 0; }
          }
          if (att <= 0) { att = 0; v.state = 1; }
          break;
        }
        case 1: {
          att += 2 * RATE_DEC[this._rate(v, v.d1r)];
          const dl = v.dl === 15 ? 992 : v.dl << 5;
          if (att >= dl) { att = dl; v.state = 2; }
          break;
        }
        case 2:
          att += 2 * RATE_DEC[this._rate(v, v.d2r)];
          break;
        default:
          att += 2 * RATE_DEC[v.damp ? 58 : this._rate(v, v.rr)];
          break;
      }
      if (att >= 1023) { att = 1023; if (v.state === 3) { v.active = false; v.att = att; continue; } }
      v.att = att;

      // TL 補間
      if (v.tlCur !== v.tl) {
        if (v.ld) v.tlCur = v.tl;
        else v.tlCur += v.tlCur < v.tl ? 1 : -1;
      }

      // 位置更新
      v.pos += inc;
      if (v.pos >= v.end) {
        if (v.loop >= v.end) v.pos = 0;
        else v.pos = v.loop + ((v.pos - v.end) % (v.end - v.loop));
      }
      // 4点3次補間 (ループ境界も考慮)
      const ip = v.pos | 0, fr = v.pos - ip;
      const sa = this._smp(v, this._wrapIdx(v, ip - 1));
      const sb = this._smp(v, this._wrapIdx(v, ip));
      const sc = this._smp(v, this._wrapIdx(v, ip + 1));
      const sd = this._smp(v, this._wrapIdx(v, ip + 2));
      const smp = cubic(sa, sb, sc, sd, fr);

      // 音量: 端数補間 + 1極LPFで平滑化 (約0.1ms, アタックは損なわない)
      const tot = att + (v.tlCur << 2) + amAtt;
      v.gL += (ampOf(tot + PAN_L[v.pan] * 4) - v.gL) * 0.2;
      v.gR += (ampOf(tot + PAN_R[v.pan] * 4) - v.gR) * 0.2;
      L += smp * v.gL;
      R += smp * v.gR;
    }
    this.outL = L; this.outR = R;
  }
}

// =====================================================================
//  チップ (リサンプラ + ミキサ)
// =====================================================================
// ---- 帯域制限 sinc リサンプラ用テーブル ----
const SINC_TAPS = 48;
const SINC_PHASES = 256;
const SINC_BETA = 7.5;
const _sincCache = new Map();

function besselI0(x) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 40; k++) { term *= q / (k * k); sum += term; if (term < 1e-14 * sum) break; }
  return sum;
}

/** fc: 通過帯域の上限 (ネイティブ・ナイキストに対する比 0〜1) */
function getSincTable(fc) {
  const key = fc.toFixed(5);
  let tab = _sincCache.get(key);
  if (tab) return tab;
  const T = SINC_TAPS, P = SINC_PHASES, half = T / 2;
  tab = new Float64Array((P + 1) * T);
  const i0b = besselI0(SINC_BETA);
  for (let p = 0; p <= P; p++) {
    const t = p / P;
    let sum = 0;
    const row = p * T;
    for (let i = 0; i < T; i++) {
      const d = i - (half - 1) - t;
      const x = d / half;
      let w = 0;
      if (Math.abs(x) < 1) w = besselI0(SINC_BETA * Math.sqrt(1 - x * x)) / i0b;
      const a = Math.PI * fc * d;
      const sinc = Math.abs(a) < 1e-9 ? 1 : Math.sin(a) / a;
      const v = fc * sinc * w;
      tab[row + i] = v; sum += v;
    }
    for (let i = 0; i < T; i++) tab[row + i] /= sum;   // DC ゲイン = 1
  }
  _sincCache.set(key, tab);
  return tab;
}

class OplChipBase {
  constructor(outRate, nativeRate) {
    this.outRate = outRate;
    this.nativeRate = nativeRate;
    this.step = nativeRate / outRate;
    this.acc = 0;
    const T = SINC_TAPS;
    this._T = T;
    // ダウンサンプル時は出力ナイキスト手前で遮断 (折り返し防止)。アップサンプル時は
    // イメージが可聴域外 (>22kHz) に出るだけなので、ほぼ全帯域を通す。
    this._bypass = Math.abs(this.step - 1) < 1e-9;       // 同一レートなら補間なし (完全透過)
    this._tab = getSincTable(outRate < nativeRate ? (outRate / nativeRate) * 0.955 : 0.995);
    this._hL = new Float64Array(T * 2);
    this._hR = new Float64Array(T * 2);
    this._hp = 0;
    this.dcCoef = Math.pow(0.9995, 44100 / outRate);
    this.dcL = 0; this.dcR = 0; this.prevL = 0; this.prevR = 0;
    this._o = [0, 0];
    this._n = [0, 0];        // _nativeSample の出力 (再利用)
  }

  _nativeSample() { this._n[0] = 0; this._n[1] = 0; return this._n; }

  renderSample() {
    const T = this._T;
    this.acc += this.step;
    while (this.acc >= 1) {
      this.acc -= 1;
      const n = this._nativeSample();
      const p = this._hp;
      this._hL[p] = this._hL[p + T] = n[0];
      this._hR[p] = this._hR[p + T] = n[1];
      this._hp = p + 1 >= T ? 0 : p + 1;
    }
    if (this._bypass) {
      const mid = this._hp + (T >> 1) - 1;
      return this._dc(this._hL[mid], this._hR[mid]);
    }
    // 位相 t でのポリフェーズ sinc 補間 (係数は隣接位相を線形補間)
    const ph = this.acc * SINC_PHASES, pi = ph | 0, pf = ph - pi;
    const tab = this._tab, r0 = pi * T, r1 = r0 + T, hp = this._hp;
    const hL = this._hL, hR = this._hR;
    let mixL = 0, mixR = 0;
    for (let i = 0; i < T; i++) {
      const c0 = tab[r0 + i];
      const c = c0 + (tab[r1 + i] - c0) * pf;
      mixL += c * hL[hp + i];
      mixR += c * hR[hp + i];
    }

    return this._dc(mixL, mixR);
  }

  /** DC ブロッカ (1次ハイパス) */
  _dc(mixL, mixR) {
    const k = this.dcCoef;
    const oL = mixL - this.prevL + k * this.dcL;
    const oR = mixR - this.prevR + k * this.dcR;
    this.prevL = mixL; this.prevR = mixR;
    this.dcL = oL; this.dcR = oR;
    this._o[0] = oL; this._o[1] = oR;
    return this._o;
  }
}

/** YMF262 (OPL3) */
class YMF262 extends OplChipBase {
  constructor(outRate, clock) {
    clock = clock || OPL3_CLOCK;
    super(outRate, clock / 288);
    this.clock = clock;
    this.fm = new OPL3Core();
  }
  write(port, addr, data) { this.fm.write(port & 1, addr, data); }
  _nativeSample() {
    this.fm.generate();
    const n = this._n;
    n[0] = this.fm.outL * FM_GAIN; n[1] = this.fm.outR * FM_GAIN;
    return n;
  }
}

/** YMF278B (OPL4) = OPL3 FM + 24ch ウェーブテーブルPCM */
class OPL4Chip extends OplChipBase {
  constructor(outRate, clock) {
    clock = clock || OPL4_CLOCK;
    super(outRate, clock / 768);
    this.clock = clock;
    this.mem = new Uint8Array(MEM_SIZE);
    this.fm = new OPL3Core();
    this.pcm = new PcmCore(this.mem, this.nativeRate);
    this.fmGL = 1; this.fmGR = 1; this.pcmGL = 1; this.pcmGR = 1;
  }

  /** ROM (0x000000〜) を読み込む。VGMのデータブロック(0x84)相当 */
  loadRom(data, start = 0) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (start >= RAM_BASE) return;
    this.mem.set(d.subarray(0, Math.min(d.length, RAM_BASE - start)), start);
  }
  /** RAM (0x200000〜) を読み込む。start は RAM 先頭からのオフセット(絶対アドレスも可) */
  loadRam(data, start = 0) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    const a = start < RAM_BASE ? start + RAM_BASE : start;
    if (a >= MEM_SIZE) return;
    this.mem.set(d.subarray(0, Math.min(d.length, MEM_SIZE - a)), a);
  }
  /** 4MB メモリ全体をそのまま差し込む */
  loadMemory(mem) {
    this.mem.set(mem.subarray(0, MEM_SIZE));
  }

  write(port, addr, data) {
    addr &= 0xff; data &= 0xff;
    if (port === 2) {
      if (addr === 0xf8) { this.fmGL = MIX_GAIN[data & 7]; this.fmGR = MIX_GAIN[(data >> 3) & 7]; return; }
      if (addr === 0xf9) { this.pcmGL = MIX_GAIN[data & 7]; this.pcmGR = MIX_GAIN[(data >> 3) & 7]; return; }
      this.pcm.write(addr, data);
    } else {
      this.fm.write(port & 1, addr, data);
    }
  }

  _nativeSample() {
    this.fm.generate();
    this.pcm.generate();
    const n = this._n;
    n[0] = this.fm.outL * FM_GAIN * this.fmGL + this.pcm.outL * PCM_GAIN * this.pcmGL;
    n[1] = this.fm.outR * FM_GAIN * this.fmGR + this.pcm.outR * PCM_GAIN * this.pcmGR;
    return n;
  }
}

// =====================================================================
//  VGM パーサ
// =====================================================================
class VGMParser {
  constructor(arrayBuffer) {
    this.buf = new Uint8Array(arrayBuffer);
    this.view = new DataView(arrayBuffer);
    this.header = {};
    this.gd3 = null;
    this.events = [];
    this.totalSamples = 0;
    this.loopSampleOffset = -1;
    this.opl4Mem = null;        // データブロック由来の 4MB メモリイメージ
    this._parse();
  }

  _readU32(off) { return this.view.getUint32(off, true); }
  _readU16(off) { return this.view.getUint16(off, true); }
  _magic(off) {
    return String.fromCharCode(this.buf[off], this.buf[off + 1], this.buf[off + 2], this.buf[off + 3]);
  }

  _parse() {
    if (this._magic(0) !== 'Vgm ') throw new Error('VGMファイルではありません (シグネチャ不一致)');
    const h = this.header;
    h.eofOffset = this._readU32(0x04);
    h.version = this._readU32(0x08);
    h.gd3Offset = this._readU32(0x14);
    h.totalSamples = this._readU32(0x18);
    h.loopOffset = this._readU32(0x1c);
    h.loopSamples = this._readU32(0x20);
    h.ymf262Clock = 0;
    h.ymf278bClock = 0;
    h.dataOffset = 0x40;

    if (h.version >= 0x150) {
      const dataOff = this._readU32(0x34);
      h.dataOffset = dataOff !== 0 ? dataOff + 0x34 : 0x40;
    }
    if (h.version >= 0x151 && h.dataOffset >= 0x5c && this.buf.length >= 0x5c) {
      if (h.dataOffset >= 0x60) h.ymf262Clock = this._readU32(0x5c) & 0x3fffffff;
      if (h.dataOffset >= 0x64) h.ymf278bClock = this._readU32(0x60) & 0x3fffffff;
    }

    this.totalSamples = h.totalSamples;
    this.loopByteOffset = h.loopOffset ? h.loopOffset + 0x1c : -1;
    if (h.gd3Offset) this._parseGD3(h.gd3Offset + 0x14);
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
        } else cur.push(String.fromCharCode(code));
      }
      this.gd3 = {
        trackNameEn: strs[0] || '', trackNameJp: strs[1] || '',
        gameNameEn: strs[2] || '', gameNameJp: strs[3] || '',
        systemNameEn: strs[4] || '', systemNameJp: strs[5] || '',
        authorEn: strs[6] || '', authorJp: strs[7] || '',
        releaseDate: strs[8] || '', vgmBy: strs[9] || '', notes: strs[10] || '',
      };
    } catch (e) { this.gd3 = null; }
  }

  _parseCommands() {
    const buf = this.buf;
    let p = this.header.dataOffset;
    const end = this.header.gd3Offset ? Math.min(buf.length, this.header.gd3Offset + 0x14) : buf.length;
    let sampleOffset = 0;
    const loopStartByte = this.loopByteOffset;

    while (p < end && p < buf.length) {
      const cmd = buf[p];
      if (loopStartByte >= 0 && p === loopStartByte) this.loopSampleOffset = sampleOffset;

      if (cmd === 0x66) {
        this.events.push({ sampleOffset, type: 'end' });
        break;
      } else if (cmd === 0xd0) {
        this.events.push({ sampleOffset, type: 'ymf278b', port: buf[p + 1] & 0x7f, addr: buf[p + 2], data: buf[p + 3] });
        p += 4;
      } else if (cmd === 0x5e || cmd === 0x5f) {
        this.events.push({ sampleOffset, type: 'ymf262', port: cmd === 0x5f ? 1 : 0, addr: buf[p + 1], data: buf[p + 2] });
        p += 3;
      } else if (cmd === 0x61) {
        sampleOffset += this._readU16(p + 1); p += 3;
      } else if (cmd === 0x62) {
        sampleOffset += 735; p += 1;
      } else if (cmd === 0x63) {
        sampleOffset += 882; p += 1;
      } else if (cmd >= 0x70 && cmd <= 0x7f) {
        sampleOffset += (cmd & 0x0f) + 1; p += 1;
      } else if (cmd >= 0x80 && cmd <= 0x8f) {
        sampleOffset += (cmd & 0x0f); p += 1;
      } else if (cmd === 0x67) {
        const dataType = buf[p + 2];
        const size = this._readU32(p + 3);
        if (dataType === 0x84 || dataType === 0x87) {
          const startAddr = this._readU32(p + 11);
          const data = buf.subarray(p + 15, p + 7 + size);
          if (!this.opl4Mem) this.opl4Mem = new Uint8Array(MEM_SIZE);
          let a = startAddr;
          if (dataType === 0x87 && a < RAM_BASE) a += RAM_BASE;
          if (a < MEM_SIZE) this.opl4Mem.set(data.subarray(0, MEM_SIZE - a), a);
        }
        p += 7 + size;
      } else if (cmd === 0x68) {
        p += 12;
      } else if (cmd === 0x64) {
        p += 4;
      } else if ((cmd >= 0x30 && cmd <= 0x3f) || cmd === 0x4f || cmd === 0x50) {
        p += 2;
      } else if ((cmd >= 0x40 && cmd <= 0x4e) || (cmd >= 0x51 && cmd <= 0x5f) || (cmd >= 0xa0 && cmd <= 0xbf)) {
        p += 3;
      } else if (cmd >= 0x90 && cmd <= 0x95) {
        if (cmd === 0x90 || cmd === 0x91 || cmd === 0x95) p += 5;
        else if (cmd === 0x92) p += 6;
        else if (cmd === 0x93) p += 11;
        else p += 2;
      } else if (cmd >= 0xc0 && cmd <= 0xdf) {
        p += 4;
      } else if (cmd >= 0xe0) {
        p += 5;
      } else {
        p += 1;
      }
    }

    if (this.events.length === 0 || this.events[this.events.length - 1].type !== 'end') {
      this.events.push({ sampleOffset, type: 'end' });
    }
  }
}

// =====================================================================
//  SpatialFX: 臨場感 / 没入感 ポストプロセッサ (Web Audio 非依存・純粋 DSP)
//    1) 疑似ステレオ拡張 (低域は中央固定のまま、高域だけ M/S + オールパス脱相関でワイド化)
//    2) 初期反射 (左右で異なる12タップ → 部屋の大きさ・距離感)
//    3) 8ライン FDN リバーブ (Hadamard 行列, 周波数依存減衰, 遅延モジュレーションで金属音抑制)
//    4) クロスフィード (ヘッドホン向け, 任意)
//    5) ルックアヘッド・リミッタ + ソフトクリップ (歪まず音圧を稼ぐ)
// =====================================================================
const FX_PRESETS = {
  off:       { enabled: false },
  natural:   { enabled: true, width: 1.15, decorrelate: 0.15, early: 0.10, reverb: 0.10, rt60: 1.1, damping: 0.35, predelay: 0.012, size: 0.9, crossfeed: 0,    limiter: true },
  immersive: { enabled: true, width: 1.35, decorrelate: 0.35, early: 0.18, reverb: 0.20, rt60: 1.7, damping: 0.40, predelay: 0.020, size: 1.0, crossfeed: 0,    limiter: true },
  hall:      { enabled: true, width: 1.50, decorrelate: 0.40, early: 0.22, reverb: 0.32, rt60: 2.8, damping: 0.50, predelay: 0.030, size: 1.3, crossfeed: 0,    limiter: true },
  headphone: { enabled: true, width: 1.20, decorrelate: 0.30, early: 0.16, reverb: 0.18, rt60: 1.6, damping: 0.42, predelay: 0.020, size: 1.0, crossfeed: 0.30, limiter: true },
};

class Allpass {
  constructor(len, g) { this.buf = new Float32Array(Math.max(1, len)); this.i = 0; this.g = g; }
  process(x) {
    const b = this.buf, i = this.i, wd = b[i];
    const w = x + this.g * wd;
    b[i] = w;
    this.i = i + 1 >= b.length ? 0 : i + 1;
    return wd - this.g * w;
  }
  reset() { this.buf.fill(0); this.i = 0; }
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

class SpatialFX {
  constructor(sr, preset = 'immersive', overrides = null) {
    this.sr = sr;
    const k = sr / 48000;
    this.outL = 0; this.outR = 0;
    this.enabled = true;

    // --- 脱相関オールパス (L/R で遅延長を変える) ---
    const apLens = [142, 107, 379, 277], apLensR = [151, 113, 397, 293];
    this.apL = apLens.map(n => new Allpass(Math.round(n * k), 0.5));
    this.apR = apLensR.map(n => new Allpass(Math.round(n * k), 0.5));
    this.sLp = 0; this.mLp = 0;
    this.aSide = 1 - Math.exp(-2 * Math.PI * 160 / sr);

    // --- 初期反射 ---
    this.erSize = nextPow2(Math.ceil(0.09 * sr));
    this.erMask = this.erSize - 1;
    this.erBufL = new Float32Array(this.erSize);
    this.erBufR = new Float32Array(this.erSize);
    this.erPos = 0;
    const ms = (v) => Math.round(v * 0.001 * sr);
    // [遅延ms, 0=自chから/1=反対chから, ゲイン(符号で脱相関)]
    this.erTapsL = [[7.1, 0, .50], [12.9, 1, -.42], [19.3, 0, .34], [26.7, 1, -.28], [35.9, 0, .22], [47.3, 1, -.16]]
      .map(t => [ms(t[0]), t[1], t[2]]);
    this.erTapsR = [[8.9, 0, .50], [14.3, 1, -.42], [21.7, 0, .34], [29.9, 1, -.28], [39.1, 0, .22], [51.7, 1, -.16]]
      .map(t => [ms(t[0]), t[1], t[2]]);
    this.erLpL = 0; this.erLpR = 0;
    this.aEr = 1 - Math.exp(-2 * Math.PI * 7000 / sr);

    // --- リバーブ ---
    this.pdSize = nextPow2(Math.ceil(0.2 * sr));
    this.pdMask = this.pdSize - 1;
    this.pdL = new Float32Array(this.pdSize);
    this.pdR = new Float32Array(this.pdSize);
    this.pdPos = 0;
    this.revHpL = 0; this.revHpR = 0;
    this.aRevHp = 1 - Math.exp(-2 * Math.PI * 180 / sr);

    this.N = 8;
    this._baseLens = [1031, 1327, 1559, 1747, 1993, 2237, 2477, 2731];
    this.modDepth = 4 * k;
    this.dBuf = []; this.dSize = [];
    const maxLen = Math.ceil(this._baseLens[7] * k * 1.6) + Math.ceil(this.modDepth) + 8;
    for (let i = 0; i < 8; i++) { this.dBuf.push(new Float32Array(maxLen)); this.dSize.push(maxLen); }
    this.dPos = new Int32Array(8);
    this.dLen = new Float64Array(8);
    this.dG = new Float64Array(8);
    this.dLp = new Float64Array(8);
    this.dTmp = new Float64Array(8);
    this.dY = new Float64Array(8);
    this.lfoPh = new Float64Array(8);
    this.lfoInc = new Float64Array(8);
    const rates = [0.17, 0.23, 0.29, 0.31, 0.37, 0.41, 0.43, 0.47];
    for (let i = 0; i < 8; i++) { this.lfoPh[i] = i * 0.7; this.lfoInc[i] = 2 * Math.PI * rates[i] / sr; }

    // --- クロスフィード ---
    this.cfLpL = 0; this.cfLpR = 0;
    this.aCf = 1 - Math.exp(-2 * Math.PI * 700 / sr);

    // --- リミッタ ---
    this.limN = Math.max(2, Math.round(0.0015 * sr));
    this.limL = new Float32Array(this.limN);
    this.limR = new Float32Array(this.limN);
    this.limI = 0; this.limGain = 1;
    this.limAtk = 1 - Math.exp(-1 / (0.00025 * sr));
    this.limRel = 1 - Math.exp(-1 / (0.12 * sr));
    this.limThr = 0.84;

    this.p = {};
    this.setPreset(preset, overrides);
  }

  /** ライブ変更用 (例: fx.set({ reverb: 0.3, width: 1.6 })) */
  set(params) {
    const p = Object.assign(this.p, params);
    this.enabled = p.enabled !== false;
    const k = this.sr / 48000, size = Math.max(0.3, Math.min(1.6, p.size || 1));
    this.pdLen = Math.max(1, Math.round((p.predelay || 0) * this.sr));
    const rt60 = Math.max(0.2, p.rt60 || 1.5) * 1.2;   // 高域ダンピングで実測が短くなる分を補正
    for (let i = 0; i < 8; i++) {
      const len = Math.round(this._baseLens[i] * k * size);
      this.dLen[i] = len;
      this.dG[i] = Math.pow(10, -3 * len / (rt60 * this.sr));
    }
    this.dDamp = Math.max(0, Math.min(0.95, p.damping == null ? 0.4 : p.damping));
    return this;
  }

  setPreset(name, overrides) {
    const base = FX_PRESETS[name] || FX_PRESETS.immersive;
    this.p = {};
    this.set(Object.assign({}, base, overrides || {}));
    return this;
  }

  reset() {
    for (const a of this.apL) a.reset();
    for (const a of this.apR) a.reset();
    this.erBufL.fill(0); this.erBufR.fill(0);
    this.pdL.fill(0); this.pdR.fill(0);
    for (const b of this.dBuf) b.fill(0);
    this.dLp.fill(0);
    this.limL.fill(0); this.limR.fill(0);
    this.sLp = this.mLp = this.erLpL = this.erLpR = 0;
    this.revHpL = this.revHpR = this.cfLpL = this.cfLpR = 0;
    this.limGain = 1;
  }

  process(inL, inR) {
    const p = this.p;
    if (!this.enabled) { this.outL = inL; this.outR = inR; return; }

    // ---------- 1) ステレオ拡張 ----------
    let M = (inL + inR) * 0.5, S = (inL - inR) * 0.5;
    this.sLp += (S - this.sLp) * this.aSide;
    this.mLp += (M - this.mLp) * this.aSide;
    const sHp = S - this.sLp, mHp = M - this.mLp;
    let dec = 0;
    if (p.decorrelate > 0) {
      let a = mHp, b = mHp;
      for (let i = 0; i < 4; i++) { a = this.apL[i].process(a); b = this.apR[i].process(b); }
      dec = (a - b) * 0.5 * p.decorrelate;
    }
    const S2 = this.sLp + (p.width == null ? 1 : p.width) * (sHp + dec);
    let l = M + S2, r = M - S2;

    // ---------- 4) クロスフィード ----------
    if (p.crossfeed > 0) {
      this.cfLpL += (l - this.cfLpL) * this.aCf;
      this.cfLpR += (r - this.cfLpR) * this.aCf;
      const cf = p.crossfeed, nrm = 1 / (1 + cf * 0.6);
      const l2 = (l + cf * this.cfLpR) * nrm, r2 = (r + cf * this.cfLpL) * nrm;
      l = l2; r = r2;
    }

    // ---------- 2) 初期反射 ----------
    let erL = 0, erR = 0;
    if (p.early > 0) {
      const ep = this.erPos, em = this.erMask;
      this.erBufL[ep] = l; this.erBufR[ep] = r;
      for (const t of this.erTapsL) { const src = t[1] ? this.erBufR : this.erBufL; erL += t[2] * src[(ep - t[0]) & em]; }
      for (const t of this.erTapsR) { const src = t[1] ? this.erBufL : this.erBufR; erR += t[2] * src[(ep - t[0]) & em]; }
      this.erPos = (ep + 1) & em;
      this.erLpL += (erL - this.erLpL) * this.aEr; erL = this.erLpL;
      this.erLpR += (erR - this.erLpR) * this.aEr; erR = this.erLpR;
    }

    // ---------- 3) FDN リバーブ ----------
    let wetL = 0, wetR = 0;
    if (p.reverb > 0) {
      // 低域カット + プリディレイ
      this.revHpL += (l - this.revHpL) * this.aRevHp;
      this.revHpR += (r - this.revHpR) * this.aRevHp;
      const pp = this.pdPos, pm = this.pdMask;
      this.pdL[pp] = l - this.revHpL; this.pdR[pp] = r - this.revHpR;
      const rp = (pp - this.pdLen) & pm;
      const xl = this.pdL[rp], xr = this.pdR[rp];
      this.pdPos = (pp + 1) & pm;

      const y = this.dY, tmp = this.dTmp, damp = this.dDamp, ia = 1 - damp;
      for (let i = 0; i < 8; i++) {
        const buf = this.dBuf[i], size = this.dSize[i];
        const mod = this.modDepth * Math.sin(this.lfoPh[i]);
        this.lfoPh[i] += this.lfoInc[i];
        if (this.lfoPh[i] > 6.283185307179586) this.lfoPh[i] -= 6.283185307179586;
        let pos = this.dPos[i] - (this.dLen[i] + mod);
        while (pos < 0) pos += size;
        const i0 = pos | 0, fr = pos - i0;
        const i1 = i0 + 1 >= size ? 0 : i0 + 1;
        const v = buf[i0] + (buf[i1] - buf[i0]) * fr;
        y[i] = v;
        this.dLp[i] = ia * v + damp * this.dLp[i];
        tmp[i] = this.dLp[i] * this.dG[i];
      }
      // 高速 Walsh-Hadamard (直交行列 → エネルギー保存)
      for (let h = 1; h < 8; h <<= 1) {
        for (let i = 0; i < 8; i += h << 1) {
          for (let j = i; j < i + h; j++) { const a = tmp[j], b = tmp[j + h]; tmp[j] = a + b; tmp[j + h] = a - b; }
        }
      }
      const IN = 0.9, SC = 0.35355339059327373;
      for (let i = 0; i < 8; i++) {
        const buf = this.dBuf[i];
        buf[this.dPos[i]] = tmp[i] * SC + ((i & 1) ? xr : xl) * IN;
        this.dPos[i] = this.dPos[i] + 1 >= this.dSize[i] ? 0 : this.dPos[i] + 1;
      }
      wetL = (y[0] + y[2] + y[4] + y[6]) * 0.5;
      wetR = (y[1] + y[3] + y[5] + y[7]) * 0.5;
    }

    let oL = l + p.early * erL + p.reverb * wetL;
    let oR = r + p.early * erR + p.reverb * wetR;

    // ---------- 5) リミッタ ----------
    if (p.limiter !== false) {
      const peak = Math.max(Math.abs(oL), Math.abs(oR));
      const target = peak > this.limThr ? this.limThr / peak : 1;
      this.limGain += (target - this.limGain) * (target < this.limGain ? this.limAtk : this.limRel);
      const li = this.limI;
      const dl = this.limL[li], dr = this.limR[li];
      this.limL[li] = oL; this.limR[li] = oR;
      this.limI = li + 1 >= this.limN ? 0 : li + 1;
      oL = dl * this.limGain; oR = dr * this.limGain;
    }
    this.outL = oL; this.outR = oR;
  }
}

// =====================================================================
//  VGM Player (Web Audio API ScriptProcessorNode)
// =====================================================================
class VGMPlayer {
  /**
   * @param {AudioContext} audioCtx
   * @param {number} vgmSampleRate  VGM 内部時間の基準 (通常 44100)
   * @param {object} [options]  { fxPreset: 'immersive'|'natural'|'hall'|'headphone'|'off',
   *                              fx: {width, reverb, ...}, bufferSize: 8192 }
   */
  constructor(audioCtx, vgmSampleRate = 44100, options = {}) {
    this.audioCtx = audioCtx;
    this.vgmRate = vgmSampleRate;
    this.chip262 = null;
    this.chip278 = null;
    this.cfg = null;
    this.extRom = null;
    this.events = [];
    this.eventIndex = 0;
    this.totalSamples = 0;
    this.loopSampleOffset = -1;
    this.currentSample = 0;
    this.playing = false;
    this.loopEnabled = true;
    this.ended = false;

    this.outRate = audioCtx.sampleRate;
    this.vgmPerOut = this.vgmRate / this.outRate;
    this._posCounter = 0;

    this.onPosition = null;
    this.onEnded = null;
    this.onLooped = null;

    this.fx = new SpatialFX(this.outRate, options.fxPreset || 'immersive', options.fx || null);
    this._idle = 0;
    this._tailSamples = Math.ceil(this.outRate * 6);   // 停止後にリバーブ残響を鳴らし切る長さ

    this.node = this.audioCtx.createScriptProcessor(options.bufferSize || 8192, 0, 2);
    this.node.onaudioprocess = (e) => this._process(e);
  }

  /** 空間エフェクトのプリセット切替: 'off' | 'natural' | 'immersive' | 'hall' | 'headphone' */
  setFxPreset(name, overrides) { this.fx.setPreset(name, overrides); this._idle = 0; }
  /** 空間エフェクトのパラメータをライブ変更 (例: { reverb: 0.3, width: 1.5 }) */
  setFx(params) { this.fx.set(params); }

  connect(destination) { this.node.connect(destination); }
  disconnect() { try { this.node.disconnect(); } catch (e) { /* ignore */ } }

  /** 外部ウェーブROM (yrw801.rom 等) を指定。次回の load/stop/seek から有効 */
  loadRom(arrayBuffer) {
    this.extRom = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    if (this.chip278) this.chip278.loadRom(this.extRom);
  }

  _createChips() {
    const c = this.cfg;
    if (!c) return;
    this.chip262 = c.ymf262Clock ? new YMF262(this.outRate, c.ymf262Clock) : null;
    this.chip278 = c.ymf278bClock ? new OPL4Chip(this.outRate, c.ymf278bClock) : null;
    if (this.chip278) {
      if (this.extRom) this.chip278.loadRom(this.extRom);
      if (c.opl4Mem) this.chip278.loadMemory(c.opl4Mem);
    }
  }

  load(vgmParser) {
    this.events = vgmParser.events;
    this.totalSamples = vgmParser.totalSamples;
    this.loopSampleOffset = vgmParser.loopSampleOffset;
    this.eventIndex = 0;
    this.currentSample = 0;

    const h = vgmParser.header;
    let c262 = h.ymf262Clock, c278 = h.ymf278bClock;
    if (!c262 && !c278) {
      if (this.events.some(e => e.type === 'ymf278b')) c278 = OPL4_CLOCK;
      if (this.events.some(e => e.type === 'ymf262')) c262 = OPL3_CLOCK;
    }
    this.cfg = { ymf262Clock: c262, ymf278bClock: c278, opl4Mem: vgmParser.opl4Mem };
    this._createChips();
    this.ended = false;
    this.playing = false;
  }

  play() { this.playing = true; }
  pause() { this.playing = false; }

  stop() {
    this.playing = false;
    this.currentSample = 0;
    this.eventIndex = 0;
    this._createChips();
    this.fx.reset();
  }

  _dispatch(ev) {
    if (ev.type === 'ymf278b') {
      if (this.chip278) this.chip278.write(ev.port, ev.addr, ev.data);
    } else if (ev.type === 'ymf262') {
      if (this.chip262) this.chip262.write(ev.port, ev.addr, ev.data);
    }
  }

  seekSample(targetSample) {
    this._createChips();
    this.fx.reset();
    let i = 0;
    while (i < this.events.length && this.events[i].sampleOffset <= targetSample) {
      this._dispatch(this.events[i]);
      i++;
    }
    this.eventIndex = i;
    this.currentSample = targetSample;
  }

  setLoop(enabled) { this.loopEnabled = enabled; }

  _renderChips() {
    let l = 0, r = 0;
    if (this.chip262) { const s = this.chip262.renderSample(); l += s[0]; r += s[1]; }
    if (this.chip278) { const s = this.chip278.renderSample(); l += s[0]; r += s[1]; }
    const o = this._mix || (this._mix = [0, 0]);   // 配列を再利用 (GC 回避)
    o[0] = l; o[1] = r;
    return o;
  }

  _renderOneOut() {
    while (this.eventIndex < this.events.length && this.events[this.eventIndex].sampleOffset <= this.currentSample) {
      const ev = this.events[this.eventIndex];
      if (ev.type === 'end') {
        if (this.loopEnabled && this.loopSampleOffset >= 0) {
          this.currentSample = this.loopSampleOffset;
          let li = 0;
          while (li < this.events.length && this.events[li].sampleOffset < this.loopSampleOffset) li++;
          this.eventIndex = li;
          if (this.onLooped) this.onLooped();
          continue;
        }
        this.ended = true;
        this.playing = false;
        if (this.onEnded) this.onEnded();
        return null;
      }
      this._dispatch(ev);
      this.eventIndex++;
    }
    const sample = this._renderChips();
    this.currentSample += this.vgmPerOut;
    return sample;
  }

  _process(e) {
    const left = e.outputBuffer.getChannelData(0);
    const right = e.outputBuffer.getChannelData(1);
    const n = left.length, fx = this.fx;

    // 停止中でも残響が消えるまで処理し、消えたら完全に無音で返す
    if ((!this.playing || this.ended) && (!fx.enabled || this._idle >= this._tailSamples)) {
      left.fill(0); right.fill(0);
      return;
    }

    for (let i = 0; i < n; i++) {
      let l = 0, r = 0;
      if (this.playing && !this.ended) {
        const s = this._renderOneOut();
        if (s) { l = s[0]; r = s[1]; }
        this._idle = 0;
      } else {
        this._idle++;
      }
      if (fx.enabled) { fx.process(l, r); l = fx.outL; r = fx.outR; }
      left[i] = softOut(l);
      right[i] = softOut(r);
    }

    this._posCounter += n;
    if (this._posCounter > 4096) {
      this._posCounter = 0;
      if (this.onPosition) this.onPosition({ sample: Math.floor(this.currentSample), total: this.totalSamples });
    }
  }
}

// ユーティリティ: Gzip（.vgz）解凍
async function decompressVgz(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return arrayBuffer;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream 非対応ブラウザのため .vgz の解凍ができません');
  }
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

// =====================================================================
//  エクスポート定義 (ESM & Browser Global)
// =====================================================================
const YMF278B = OPL4Chip;

export {
  VGMParser,
  OPL3Core,
  OPL4Chip,
  YMF278B,
  YMF262,
  VGMPlayer,
  SpatialFX,
  FX_PRESETS,
  decompressVgz
};

if (typeof window !== 'undefined') {
  window.OPL4Synth = {
    VGMParser,
    OPL3Core,
    OPL4Chip,
    YMF278B,
    YMF262,
    VGMPlayer,
    SpatialFX,
    FX_PRESETS,
    decompressVgz
  };
}