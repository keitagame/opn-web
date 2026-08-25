/*
 * VGM (Video Game Music) file parser
 * Spec reference: https://vgmrips.net/wiki/VGM_Specification
 *
 * Focuses on extracting:
 *  - Header info (clocks, loop point, track metadata via GD3)
 *  - The command stream as a flat array of parsed events with sample timing
 *
 * Supports the commands relevant to YM2203 playback plus generic wait/end
 * commands so unrelated chip writes are simply skipped (harmless).
 */

'use strict';

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